import path from 'path';
import { checkForUpdates } from '../lib/updates/check';

// The parent owns eligibility and the durable attempt claim. Never inherit its
// terminal or write output, including after the parent has returned to its shell.
if (require.main === module && process.argv.length === 3)
  checkForUpdates(path.resolve(__dirname, '../../..'), process.argv[2]);
