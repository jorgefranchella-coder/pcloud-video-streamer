const { runScan } = require('./indexer');
const { run: runVisualAnalysis } = require('./visual-analyzer');

async function runPipeline() {
  console.log('Pipeline: starting technical inventory');
  await runScan();
  console.log('Pipeline: starting bounded visual analysis batch');
  await runVisualAnalysis();
}

if (require.main === module) {
  runPipeline().catch(error => {
    console.error(`Pipeline failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runPipeline };
