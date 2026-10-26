# Privacy policy: gmail-mcp-multi

_Last updated: 26 October 2026_

gmail-mcp-multi is open-source software that **you run on your own computer**. It connects your Gmail accounts to an AI assistant (such as Claude) through the Model Context Protocol.

## What data it accesses
With your permission, granted on Google's consent screen, the software uses the Gmail API to read, search, label and draft emails in the accounts you connect. In `full` mode it can also send email, trash messages and manage filters. It only acts when the AI assistant you are using calls one of its tools.

## Where data goes
- **OAuth tokens** for each account are stored only on your computer, in `~/.gmail-mcp/accounts/<alias>/credentials.json`, with owner-only file permissions.
- **Email content** is fetched from Google and passed directly to the AI assistant on your computer that requested it. The authors of this software run no servers and receive, store or share none of your data.
- What the AI assistant does with that content is governed by that assistant's own privacy policy (for Claude: <https://www.anthropic.com/legal/privacy>).

## Google API Services User Data Policy
The use of information received from Google APIs complies with the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Data is not used for advertising, is not sold, and is not used to train generalized AI models by this software.

## Removing access
Run `gmail-mcp-multi remove <alias>` to delete a stored token. You can also revoke access at any time at <https://myaccount.google.com/permissions>.

## Contact
antony@psdgator.com
