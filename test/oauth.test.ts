import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountManager } from "../src/accounts.js";
import { loadClientKeys, startAuthFlow } from "../src/oauth.js";

function home(): AccountManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-oauth-"));
  fs.writeFileSync(path.join(dir, "oauth-keys.json"), JSON.stringify({ installed: { client_id: "cid.apps.googleusercontent.com", client_secret: "s" } }));
  return new AccountManager(dir);
}

describe("oauth loopback flow", () => {
  it("builds a PKCE + state sign-in URL with the right scopes and a 127.0.0.1 redirect", async () => {
    const flow = await startAuthFlow(home(), { alias: "urbanstickers", emailHint: "urbanstickersgr@gmail.com", mode: "drafts" });
    flow.done.catch(() => {});
    const u = new URL(flow.url);
    expect(u.hostname).toBe("accounts.google.com");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("login_hint")).toBe("urbanstickersgr@gmail.com");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    const redirect = new URL(u.searchParams.get("redirect_uri")!);
    expect(redirect.hostname).toBe("127.0.0.1");

    // A callback with the wrong state is rejected and the flow keeps waiting.
    const bad = await fetch(`${redirect.origin}/?code=x&state=wrong`);
    expect(bad.status).toBe(400);

    // The user pressing "Cancel" on Google's page ends the flow with a clear error.
    const cancelled = await fetch(`${redirect.origin}/?error=access_denied&state=${u.searchParams.get("state")}`);
    expect(cancelled.status).toBe(400);
    await expect(flow.done).rejects.toThrow(/access_denied/);
  });

  it("asks only for read access in readonly mode", async () => {
    const flow = await startAuthFlow(home(), { alias: "ro", mode: "readonly" });
    flow.done.catch(() => {});
    expect(new URL(flow.url).searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    flow.cancel();
  });

  it("explains a missing or malformed client file", () => {
    expect(() => loadClientKeys("/nope/oauth-keys.json")).toThrow(/Desktop app/);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gmm-k-")), "k.json");
    fs.writeFileSync(f, JSON.stringify({ web: { client_id: "a", client_secret: "b" } }));
    expect(loadClientKeys(f)).toEqual({ client_id: "a", client_secret: "b" });
    fs.writeFileSync(f, "{}");
    expect(() => loadClientKeys(f)).toThrow(/does not look like/);
  });
});
