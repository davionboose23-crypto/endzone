// Standalone worker entry: install the in-browser /api shim first, then the unchanged app worker.
import './sa-shim.js';
import '../src/worker.js';
