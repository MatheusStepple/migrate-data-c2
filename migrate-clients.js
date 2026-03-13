const fs = require('fs');
const path = require('path');
const https = require('https');

// ============================================================
// migrate-clients.js
// Reads clientes_final.tsv and posts to C2 Prev API
// Usage: node migrate-clients.js --user=<USER_ID> [--dry-run] [--start=N] [--url=URL]
// ============================================================

const INPUT_FILE = path.join(__dirname, 'clientes_final.tsv');
const REPORT_FILE = path.join(__dirname, 'migration-report.json');

const DEV_BYPASS_TOKEN = 'rvaFRDvEIdLp1PgqpBA62SZTwkWfkE';
const DEFAULT_URL = 'https://c2prevapi.compute.capital';
const DELAY_MS = 1500;

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const START_LINE = (() => {
  const startArg = args.find(a => a.startsWith('--start='));
  return startArg ? parseInt(startArg.split('=')[1], 10) : 1;
})();
const BASE_URL = (() => {
  const urlArg = args.find(a => a.startsWith('--url='));
  return urlArg ? urlArg.split('=')[1] : DEFAULT_URL;
})();
const USER_ID = (() => {
  const userArg = args.find(a => a.startsWith('--user='));
  if (!userArg) {
    console.error('ERROR: --user=<USER_ID> is required');
    console.error('Usage: node migrate-clients.js --user=<USER_ID> [--dry-run] [--start=N] [--url=URL]');
    process.exit(1);
  }
  return userArg.split('=')[1];
})();

// Lazy-load axios (must be installed: npm install axios)
let axios;
try {
  axios = require('axios');
} catch {
  console.error('axios not found. Install it: npm install axios');
  process.exit(1);
}

// HTTPS agent that ignores self-signed certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const AUTH_HEADER = `Bearer ${DEV_BYPASS_TOKEN}:${USER_ID}`;

const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': AUTH_HEADER,
  },
  httpsAgent,
  timeout: 30000,
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildClientBody(row) {
  const body = { quickCreate: true, legalType: 'FISICA' };

  const fields = [
    'name', 'cpf', 'rg', 'birthDate', 'gender', 'maritalStatus', 'nationality',
    'motherName', 'ctps', 'pis', 'email', 'cadPassword', 'contactName',
    'homePhone', 'mobilePhone', 'registrationDate', 'spouseName', 'observations',
  ];

  for (const field of fields) {
    const val = (row[field] || '').trim();
    if (val) {
      // Send dates as ISO or null
      if ((field === 'birthDate' || field === 'registrationDate') && val) {
        body[field] = val; // Already in yyyy-mm-dd format
      } else {
        body[field] = val;
      }
    }
  }

  return body;
}

function buildAddressBody(clientId, row) {
  const address = (row.address || '').trim();
  const neighborhood = (row.neighborhood || '').trim();
  const city = (row.city || '').trim();
  const state = (row.state || '').trim();
  const cep = (row.cep || '').trim();

  // Only create address if the 3 required fields are present: address, neighborhood, city
  // CEP is optional. State is optional.
  if (!address || !neighborhood || !city) {
    return null;
  }

  const body = {
    clientId,
    isPrimary: true,
    streetNumber: 'S/N',
    address,
    neighborhood,
    city,
  };

  if (state) body.state = state;
  // CEP: skip invalid values like "-", "-0", "0"
  if (cep && !/^[\-0\s]+$/.test(cep)) body.cep = cep;

  return body;
}

async function main() {
  console.log('=== C2 Prev Client Migration ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`User ID: ${USER_ID}`);
  console.log(`Auth: DEV_BYPASS_TOKEN`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Start from line: ${START_LINE}`);
  console.log('');

  // Read file, handle BOM
  let content = fs.readFileSync(INPUT_FILE, 'utf-8');
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  const lines = content.split(/\r?\n/).filter(l => l.trim());
  const headerLine = lines[0];
  const headers = headerLine.split('\t');
  const dataLines = lines.slice(1);

  console.log(`Total rows in file: ${dataLines.length}`);
  console.log(`Processing from line: ${START_LINE}`);
  console.log('');

  // Parse all rows
  const rows = dataLines.map((line, idx) => {
    const cols = line.split('\t');
    const row = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = (cols[i] || '').trim();
    }
    row._lineNum = idx + 1; // 1-based
    return row;
  });

  const report = {
    total: rows.length,
    created: 0,
    addressesCreated: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lineNum = row._lineNum;

    if (lineNum < START_LINE) {
      report.skipped++;
      continue;
    }

    const clientBody = buildClientBody(row);
    const displayName = row.name || '(sem nome)';
    const displayCpf = row.cpf || '(sem CPF)';

    if (DRY_RUN) {
      console.log(`[DRY-RUN] Line ${lineNum}: ${displayName} (${displayCpf})`);
      console.log(`  Client body:`, JSON.stringify(clientBody));
      const addrBody = buildAddressBody('FAKE_ID', row);
      if (addrBody) {
        console.log(`  Address body:`, JSON.stringify(addrBody));
      }
      report.created++;
      continue;
    }

    try {
      // Step 1: Create client (with retry on 429)
      let clientRes;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          clientRes = await apiClient.post('/clients', clientBody);
          break;
        } catch (retryErr) {
          if (axios.isAxiosError(retryErr) && retryErr.response?.status === 429) {
            const waitMs = Math.min(2000 * Math.pow(2, attempt), 30000);
            console.log(`  [429] Rate limited, waiting ${waitMs}ms (attempt ${attempt + 1}/5)...`);
            await sleep(waitMs);
            if (attempt === 4) throw retryErr;
          } else {
            throw retryErr;
          }
        }
      }
      const clientId = clientRes.data?.id || clientRes.data?.data?.id;

      if (!clientId) {
        throw new Error(`No client ID returned. Response: ${JSON.stringify(clientRes.data)}`);
      }

      console.log(`[OK] Line ${lineNum}: ${displayName} (${displayCpf}) -> ID: ${clientId}`);
      report.created++;

      // Step 2: Create address if data exists
      const addrBody = buildAddressBody(clientId, row);
      if (addrBody) {
        try {
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              await apiClient.post('/client-addresses', addrBody);
              break;
            } catch (retryErr) {
              if (axios.isAxiosError(retryErr) && retryErr.response?.status === 429) {
                const waitMs = Math.min(2000 * Math.pow(2, attempt), 30000);
                console.log(`  [429] Rate limited on address, waiting ${waitMs}ms...`);
                await sleep(waitMs);
                if (attempt === 4) throw retryErr;
              } else {
                throw retryErr;
              }
            }
          }
          console.log(`  [ADDR OK] Address created for ${displayName}`);
          report.addressesCreated++;
        } catch (addrErr) {
          const addrMsg = axios.isAxiosError(addrErr)
            ? JSON.stringify(addrErr.response?.data || addrErr.message)
            : addrErr.message;
          console.log(`  [ADDR FAIL] ${displayName}: ${addrMsg}`);
          // Don't count as overall failure - client was created
        }
      }
    } catch (err) {
      let errorMsg;
      if (axios.isAxiosError(err)) {
        errorMsg = JSON.stringify(err.response?.data || err.message);
      } else {
        errorMsg = err.message;
      }

      const isDuplicate = errorMsg.includes('duplicate') || errorMsg.includes('Unique constraint') || errorMsg.includes('already exists') || errorMsg.includes('CPF');

      if (isDuplicate) {
        console.log(`[DUP] Line ${lineNum}: ${displayName} (${displayCpf}) - CPF already exists`);
      } else {
        console.log(`[FAIL] Line ${lineNum}: ${displayName} (${displayCpf}) - ${errorMsg}`);
      }

      report.failed++;
      report.failures.push({
        line: lineNum,
        name: displayName,
        cpf: displayCpf,
        error: errorMsg,
      });
    }

    // Rate limiting
    await sleep(DELAY_MS);

  }

  // Write report
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');

  console.log('\n=== Migration Complete ===');
  console.log(`Total: ${report.total}`);
  console.log(`Created: ${report.created}`);
  console.log(`Addresses created: ${report.addressesCreated}`);
  console.log(`Failed: ${report.failed}`);
  console.log(`Skipped (before start line): ${report.skipped}`);
  console.log(`Report saved to: ${REPORT_FILE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
