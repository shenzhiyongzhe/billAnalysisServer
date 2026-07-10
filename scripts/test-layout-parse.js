const fs = require('fs');
const path = require('path');
const { StatementService } = require('../dist/src/statement/statement.service');

const svc = new StatementService({});

function simulateLayoutText(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(lines[i]) &&
      i + 1 < lines.length &&
      /^\d{2}:\d{2}:\d{2}$/.test(lines[i + 1])
    ) {
      const idParts = [];
      let j = i - 1;
      while (j >= 0 && /^[0-9]+$/.test(lines[j])) {
        idParts.unshift(lines[j]);
        j--;
      }

      const date = lines[i];
      const time = lines[i + 1];
      const rest = [];
      let k = i + 2;
      while (k < lines.length) {
        if (
          /^\d{4}-\d{2}-\d{2}$/.test(lines[k]) &&
          k + 1 < lines.length &&
          /^\d{2}:\d{2}:\d{2}$/.test(lines[k + 1])
        ) {
          break;
        }
        if (lines[k].includes('交易单号')) break;
        rest.push(lines[k]);
        k++;
      }

      out.push([...idParts, `${date} ${time}`, ...rest].join('  '));
      i = k;
      continue;
    }

    out.push(lines[i]);
    i++;
  }

  return out.join('\n');
}

async function main() {
  svc.pdfExtractor.onModuleInit();
  const buffer = fs.readFileSync(path.join(__dirname, '../uploads/test_1372.pdf'));
  const text = await svc.pdfExtractor.extractWithPdfParse(buffer);
  const normal = svc.extractData(text, '微信');
  const layoutText = simulateLayoutText(text);
  const layout = svc.extractData(layoutText, '微信');

  console.log('normal transactions:', normal.transactions.length);
  console.log('layout transactions:', layout.transactions.length);
  fs.writeFileSync(path.join(__dirname, '../uploads/test_1372_layout_head.txt'), layoutText.slice(0, 3000));
  svc.onModuleDestroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
