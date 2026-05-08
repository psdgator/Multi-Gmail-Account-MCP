import { google, gmail_v1 } from "googleapis";
import * as fs from "fs";
import { AccountManager, writeSecureFile } from "./accounts.js";

export class GmailClient {
  private clients: Map<string, gmail_v1.Gmail> = new Map();

  constructor(private accountManager: AccountManager) {}

  async getClient(aliasOrEmail: string): Promise<gmail_v1.Gmail> {
    const account = this.accountManager.getAccount(aliasOrEmail);
    if (!account) {
      throw new Error(`Account not found: ${aliasOrEmail}`);
    }

    const cached = this.clients.get(account.alias);
    if (cached) {
      return cached;
    }

    const credentialsPath = this.accountManager.getCredentialsPath(
      account.alias
    );
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(
        `Account not authenticated: ${account.alias}. Run authenticate tool first.`
      );
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));

    const oauthKeysPath = this.accountManager.getOAuthKeysPath(account.alias);
    if (!fs.existsSync(oauthKeysPath)) {
      throw new Error(`OAuth keys not found at ${oauthKeysPath}`);
    }
    const oauthKeys = JSON.parse(fs.readFileSync(oauthKeysPath, "utf-8"));

    const oauth2Client = new google.auth.OAuth2(
      oauthKeys.installed.client_id,
      oauthKeys.installed.client_secret,
      oauthKeys.installed.redirect_uris[0]
    );

    oauth2Client.setCredentials(credentials);

    // Handle token refresh
    oauth2Client.on("tokens", (tokens) => {
      if (tokens.refresh_token) {
        credentials.refresh_token = tokens.refresh_token;
      }
      credentials.access_token = tokens.access_token;
      credentials.expiry_date = tokens.expiry_date;
      writeSecureFile(credentialsPath, JSON.stringify(credentials, null, 2));
    });

    const client = google.gmail({ version: "v1", auth: oauth2Client });
    this.clients.set(account.alias, client);

    return client;
  }

  clearClient(alias: string): void {
    this.clients.delete(alias);
  }
}
