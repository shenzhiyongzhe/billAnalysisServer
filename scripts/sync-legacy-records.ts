import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });


// Helper to parse command-line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    url: 'https://www.xinde8888.com/api/query_info/persons/query-record',
    apiKey: 'bill_query_record_secret_key_2026',
    limit: undefined as number | undefined,
    batchSize: 10,
    delayMs: 200,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      options.dryRun = true;
    } else if (args[i] === '--url' && args[i + 1]) {
      options.url = args[i + 1];
      i++;
    } else if (args[i] === '--key' && args[i + 1]) {
      options.apiKey = args[i + 1];
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      options.limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--delay' && args[i + 1]) {
      options.delayMs = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: npx ts-node scripts/sync-legacy-records.ts [options]

Options:
  --dry-run             Print sync payloads without sending HTTP requests.
  --url <url>           Target API endpoint (default: https://www.xinde8888.com/api/query_info/persons/query-record).
  --key <api-key>       API key used in x-api-key header (default: bill_query_record_secret_key_2026).
  --limit <number>      Limit the number of records to sync.
  --batch-size <number> Number of requests to process in a batch (default: 10).
  --delay <ms>          Delay in milliseconds between batches (default: 200).
  --help, -h            Show this help message.
`);
      process.exit(0);
    }
  }

  return options;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const options = parseArgs();

  console.log('--- Database Synchronization Script ---');
  console.log(`Target URL:  ${options.url}`);
  console.log(`Dry Run:     ${options.dryRun ? 'YES (No requests will be sent)' : 'NO'}`);
  console.log(`Batch Size:  ${options.batchSize}`);
  console.log(`Batch Delay: ${options.delayMs}ms`);
  if (options.limit) {
    console.log(`Limit:       ${options.limit} records`);
  }
  console.log('---------------------------------------');

  // Connect to DB
  await prisma.$connect();
  console.log('Connected to database successfully.');

  // Fetch all done records
  const records = await prisma.queryRecord.findMany({
    where: {
      status: 'done',
    },
    include: {
      user: {
        select: {
          nickname: true,
          openid: true,
        },
      },
    },
    orderBy: {
      id: 'asc',
    },
    take: options.limit,
  });

  console.log(`Found ${records.length} finished query records to synchronize.`);

  let successCount = 0;
  let failCount = 0;

  // Process in batches
  for (let i = 0; i < records.length; i += options.batchSize) {
    const batch = records.slice(i, i + options.batchSize);
    console.log(`\nProcessing batch ${Math.floor(i / options.batchSize) + 1}/${Math.ceil(records.length / options.batchSize)} (records ${i + 1} to ${Math.min(i + options.batchSize, records.length)})...`);

    const promises = batch.map(async (record) => {
      const summary = (record.summaryJson && typeof record.summaryJson === 'object') 
        ? (record.summaryJson as any) 
        : {};

      const name = summary.name || '未知';
      const idNumber = summary.idNumber || null;
      const endOfId = idNumber ? String(idNumber).slice(-6) : null;
      const nickname = record.user?.nickname || null;
      const openid = record.user?.openid || null;

      const payload = {
        name,
        end_of_id: endOfId,
        first_querior: nickname,
        first_querior_id: openid,
      };

      if (options.dryRun) {
        console.log(`[DRY RUN] Record ID ${record.id}: Would send payload:`, JSON.stringify(payload));
        successCount++;
        return;
      }

      try {
        const response = await fetch(options.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': options.apiKey,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errMsg = await response.text();
          console.error(`[ERROR] Record ID ${record.id}: Remote API returned ${response.status} - ${errMsg}`);
          failCount++;
        } else {
          console.log(`[SUCCESS] Record ID ${record.id}: Synced successfully. Name: ${name}`);
          successCount++;
        }
      } catch (err: any) {
        console.error(`[ERROR] Record ID ${record.id}: Failed to sync - ${err.message || err}`);
        failCount++;
      }
    });

    await Promise.all(promises);

    if (i + options.batchSize < records.length && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  console.log('\n--- Synchronization Summary ---');
  console.log(`Total records processed: ${records.length}`);
  console.log(`Successful:              ${successCount}`);
  console.log(`Failed:                  ${failCount}`);
  console.log('-------------------------------');
}

main()
  .catch((e) => {
    console.error('Fatal error during execution:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
