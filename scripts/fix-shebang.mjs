// Deja los ejecutables publicados apuntando a Node.
//
// El bundler conserva el shebang del archivo de entrada, que es `#!/usr/bin/env bun`
// porque en desarrollo se corre con Bun. Publicado, eso obliga a quien instale el
// paquete a tener Bun: `npx cine-colombia-cli` fallaría en una máquina normal. El
// bundle en sí no necesita Bun, solo Node.

import { readFileSync, writeFileSync } from 'node:fs';

const SHEBANG = '#!/usr/bin/env node';

for (const file of ['dist/cine.js', 'dist/mcp.js']) {
  const original = readFileSync(file, 'utf-8');
  const lines = original.split('\n');

  if (lines[0]?.startsWith('#!')) lines[0] = SHEBANG;
  else lines.unshift(SHEBANG);

  writeFileSync(file, lines.join('\n'));
  process.stdout.write(`  ${file} → ${SHEBANG}\n`);
}
