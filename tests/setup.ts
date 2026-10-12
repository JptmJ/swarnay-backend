import '../src/bootstrap.js';
import { assertSafeTestDatabase } from './safety.js';

// global-setup already checked before syncing; each test file checks again in
// case it is run on its own with a different environment.
assertSafeTestDatabase();
