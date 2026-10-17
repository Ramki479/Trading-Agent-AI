/* Dashboard configuration.
 *
 * The dashboard is READ-ONLY: it only fetches from the Portfolio API, which
 * itself only READS the agent's files on the machine that owns the paper
 * account. Nothing here can trade or modify state.
 *
 * Point CIRCUIT_API_URL at the machine running dashboard-api.js:
 *   - Ubuntu (VM):  http://192.168.1.50:8787   (your Ubuntu IP + port)
 *   - same machine: http://127.0.0.1:8787
 *
 * Order of precedence (highest first):
 *   1. ?api=http://host:8787  in the browser URL
 *   2. CIRCUIT_API_URL below
 *   3. same origin (when the dashboard is served by the API itself)
 */
window.CIRCUIT_API_URL = 'http://127.0.0.1:8787';

// How often the dashboard refreshes from the API (ms).
window.CIRCUIT_POLL_MS = 3000;
