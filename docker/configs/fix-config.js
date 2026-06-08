// fix-config.js - Validate and repair openclaw.json before gateway starts
const fs = require('fs');
const path = require('path');

const configPath = path.join(process.env.HOME || '/home/dabai', '.openclaw', 'openclaw.json');
const validApis = new Set([
  'openai-completions', 'openai-responses', 'openai-codex-responses',
  'anthropic-messages', 'google-generative-ai', 'google-vertex',
  'github-copilot', 'bedrock-converse-stream', 'ollama',
  'azure-openai-responses'
]);

try {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  const providers = config?.models?.providers;
  if (!providers) { process.exit(0); }

  let fixed = false;
  for (const [name, p] of Object.entries(providers)) {
    if (p.api && !validApis.has(p.api)) {
      console.error(`fix-config: repairing ${name} api="${p.api}" -> "openai-completions"`);
      p.api = 'openai-completions';
      fixed = true;
    }
  }

  if (fixed) {
    const bak = configPath + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(configPath, bak);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.error('fix-config: config repaired, backup saved to', bak);
  }
} catch (e) {
  console.error('fix-config: error:', e.message);
}
