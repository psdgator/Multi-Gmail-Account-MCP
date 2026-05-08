#!/usr/bin/env node

import { google, Auth } from "googleapis";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import { URL } from "url";
import { AccountManager } from "./accounts.js";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

function usage(): never {
  console.error("Usage: node dist/auth.js <alias> <email>");
  console.error("");
  console.error("  alias  Friendly name for this account (e.g. 'work', 'personal')");
  console.error("  email  The Gmail address to authenticate (used as login hint)");
  process.exit(1);
}

async function main() {
  const [, , alias, email] = process.argv;
  if (!alias || !email) {
    usage();
  }

  const accountManager = new AccountManager();

  if (!accountManager.getAccount(alias)) {
    accountManager.addAccount(alias, email);
  }

  const oauthKeysPath = accountManager.getOAuthKeysPath(alias);
  if (!fs.existsSync(oauthKeysPath)) {
    console.error(`OAuth keys not found at ${oauthKeysPath}`);
    console.error(
      "Place a Google Cloud OAuth client (Desktop app) JSON there before running auth."
    );
    process.exit(1);
  }
  const oauthKeys = JSON.parse(fs.readFileSync(oauthKeysPath, "utf-8"));

  const tokens = await runFlow(oauthKeys, email);

  const oauth2Client = new google.auth.OAuth2(
    oauthKeys.installed.client_id,
    oauthKeys.installed.client_secret
  );
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const actualEmail = profile.data.emailAddress;
  if (!actualEmail) {
    throw new Error("Could not determine authenticated email address");
  }
  if (actualEmail.toLowerCase() !== email.toLowerCase()) {
    console.error(
      `Warning: signed in as ${actualEmail}, but you asked for ${email}.`
    );
    console.error(
      "Storing the actual signed-in address. Re-run if this is not what you wanted."
    );
    accountManager.addAccount(alias, actualEmail);
  }

  const credPath = accountManager.getCredentialsPath(alias);
  fs.writeFileSync(credPath, JSON.stringify(tokens, null, 2));
  fs.chmodSync(credPath, 0o600);

  console.error(`Authenticated ${actualEmail} as alias '${alias}'.`);
  console.error(`Credentials written to ${credPath}`);
}

function runFlow(
  oauthKeys: { installed: { client_id: string; client_secret: string } },
  loginHint: string
): Promise<Auth.Credentials> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${port}`;

      const oauth2Client = new google.auth.OAuth2(
        oauthKeys.installed.client_id,
        oauthKeys.installed.client_secret,
        redirectUri
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
        login_hint: loginHint,
      });

      console.error("Open this URL in a browser to authorize:");
      console.error("");
      console.error(authUrl);
      console.error("");
      console.error(`Listening for the redirect on ${redirectUri} ...`);

      server.on("request", async (req, res) => {
        try {
          const reqUrl = new URL(req.url || "/", redirectUri);
          const code = reqUrl.searchParams.get("code");
          const error = reqUrl.searchParams.get("error");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end(`OAuth error: ${error}`);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }
          if (!code) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Missing authorization code.");
            return;
          }

          const { tokens } = await oauth2Client.getToken(code);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Authentication complete. You can close this tab.");
          server.close();
          resolve(tokens);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(String(e));
          server.close();
          reject(e);
        }
      });
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
