#!/usr/bin/env node

import fs from 'node:fs/promises';

const USAGE = `Usage: node scripts/pair-marker-device.mjs \\
  --endpoint <gateway-websocket-url> \\
  --device-id <device-id> \\
  --claimed-name <claimed-name> \\
  --output <private-credential-file>

The first run reports pair_pending and exits. After the device is approved
through the Gateway's existing admin route, run the command again with the same
device ID. A successful pair_result writes its raw token to a new mode-0600 file
for CHAT_READ_MARKER_DEVICE_CREDENTIAL_FILE. Existing files are never replaced.

Requires a Node.js runtime with the built-in WebSocket client.
`;

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') return { help: true };
    if (!['--endpoint', '--device-id', '--claimed-name', '--output'].includes(option)) {
      throw new Error('Unknown or missing command-line option.');
    }
    if (values.has(option) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error('Each option must appear once and have a value.');
    }
    values.set(option, argv[++index]);
  }

  const required = ['--endpoint', '--device-id', '--claimed-name', '--output'];
  if (required.some((option) => !values.has(option))) {
    throw new Error('All four options are required.');
  }

  const endpoint = values.get('--endpoint');
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error('The Gateway WebSocket URL is invalid.');
  }
  if (!['ws:', 'wss:'].includes(parsedEndpoint.protocol) ||
      parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.hash) {
    throw new Error('The endpoint must be a WebSocket URL without embedded credentials or a fragment.');
  }

  for (const option of ['--device-id', '--claimed-name', '--output']) {
    if (!values.get(option).trim()) throw new Error(`${option} must not be empty.`);
  }

  return {
    endpoint: parsedEndpoint.href,
    deviceId: values.get('--device-id'),
    claimedName: values.get('--claimed-name'),
    outputPath: values.get('--output'),
  };
}

function requestPairing({ endpoint, deviceId, claimedName }) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') {
      reject(new Error('This Node.js runtime does not provide the built-in WebSocket client.'));
      return;
    }

    let socket;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Gateway pairing request timed out.')), 15_000);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket?.close();
      } catch {}
      if (error) reject(error);
      else resolve(result);
    }

    try {
      socket = new WebSocket(endpoint);
      socket.addEventListener('open', () => {
        try {
          socket.send(JSON.stringify({
            type: 'pair_request',
            protocolVersion: 1,
            deviceId,
            claimedName,
          }));
        } catch {
          finish(new Error('Could not send the Gateway pairing request.'));
        }
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          finish(new Error('Gateway returned an unexpected pairing response.'));
          return;
        }

        let response;
        try {
          response = JSON.parse(event.data);
        } catch {
          finish(new Error('Gateway returned an invalid pairing response.'));
          return;
        }

        if (response && response.type === 'pair_result') {
          finish(null, response);
        } else if (response && response.type === 'error') {
          finish(new Error('Gateway rejected the pairing request.'));
        } else {
          finish(new Error('Gateway returned an unexpected pairing response.'));
        }
      });
      socket.addEventListener('error', () => finish(new Error('Gateway WebSocket connection failed.')));
      socket.addEventListener('close', () => finish(new Error('Gateway closed before returning a pairing result.')));
    } catch {
      finish(new Error('Could not open the Gateway WebSocket connection.'));
    }
  });
}

async function saveCredential(outputPath, token) {
  let file;
  let created = false;
  try {
    file = await fs.open(outputPath, 'wx', 0o600);
    created = true;
    await file.chmod(0o600);
    await file.writeFile(token, { encoding: 'utf8' });
    await file.sync();
    await file.close();
    file = undefined;
  } catch (error) {
    try {
      await file?.close();
    } catch {}
    if (created) {
      try {
        await fs.unlink(outputPath);
      } catch {}
    }
    if (error?.code === 'EEXIST') {
      throw new Error('Output file already exists; refusing to overwrite it.');
    }
    throw new Error('Could not save the pairing result safely.');
  }
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  let result;
  try {
    result = await requestPairing(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.success === false && result.reason === 'pair_pending') {
    process.stdout.write('pair_pending\n');
    return;
  }

  if (result.success === false && result.reason === 'pair_denied') {
    process.stderr.write('pair_denied; no token was saved.\n');
    process.exitCode = 1;
    return;
  }

  if (result.success !== true || typeof result.token !== 'string' || result.token.length === 0) {
    process.stderr.write('Gateway returned an unsuccessful or invalid pairing result; no token was saved.\n');
    process.exitCode = 1;
    return;
  }

  try {
    await saveCredential(options.outputPath, result.token);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Pairing succeeded; the token was saved to the private credential file.\n');
}

await main();
