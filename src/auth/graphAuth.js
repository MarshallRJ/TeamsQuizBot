'use strict';

const msal = require('@azure/msal-node');

/**
 * Create a token provider that acquires a Microsoft Graph access token via the
 * ROPC (username/password) flow and caches it until shortly before expiry.
 *
 * @param {object} graphConfig  config.graph
 * @returns {{ getToken: () => Promise<string> }}
 */
function createTokenProvider(graphConfig) {
  const authority = `https://login.microsoftonline.com/${graphConfig.tenantId}`;

  const clientConfig = {
    auth: { clientId: graphConfig.clientId, authority },
  };

  // A confidential client (with secret) and a public client both support ROPC.
  const app = graphConfig.clientSecret
    ? new msal.ConfidentialClientApplication({
        auth: { ...clientConfig.auth, clientSecret: graphConfig.clientSecret },
      })
    : new msal.PublicClientApplication(clientConfig);

  let cached = null; // { token, expiresOn: Date }

  async function getToken() {
    const now = Date.now();
    if (cached && cached.expiresOn.getTime() - now > 60_000) {
      return cached.token;
    }
    const result = await app.acquireTokenByUsernamePassword({
      scopes: graphConfig.scopes,
      username: graphConfig.username,
      password: graphConfig.password,
    });
    if (!result || !result.accessToken) {
      throw new Error('Failed to acquire Graph access token (empty result).');
    }
    cached = {
      token: result.accessToken,
      expiresOn: result.expiresOn || new Date(now + 3_000_000),
    };
    return cached.token;
  }

  return { getToken };
}

module.exports = { createTokenProvider };
