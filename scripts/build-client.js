const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function build() {
  const outDir = path.join(__dirname, '..', 'public', 'dist');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'public', 'js', 'client.js')],
    bundle: true,
    outfile: path.join(outDir, 'bundle.js'),
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
    minify: false,
    logLevel: 'info'
  });

  console.log('[Build] Client bundle gerado com sucesso em public/dist/bundle.js');
}

build().catch((err) => {
  console.error('[Build] Erro ao empacotar cliente:', err);
  process.exit(1);
});
