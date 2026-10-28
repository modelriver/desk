// Deletes conversations archived longer than ARCHIVE_RETENTION_HOURS (default
// 24), in ModelRiver and locally. The production server already does this
// every hour; use this in development or from cron if you prefer.
//   npm run cleanup-archived
import { cleanupArchived } from '../src/server/archive.server.ts'
import { env } from '../src/server/env.server.ts'

if (env.archiveRetentionHours <= 0) {
  console.log('ARCHIVE_RETENTION_HOURS is 0: archived conversations are kept.')
} else {
  const n = await cleanupArchived()
  console.log(`Deleted ${n} archived conversation${n === 1 ? '' : 's'} older than ${env.archiveRetentionHours} hours.`)
}
