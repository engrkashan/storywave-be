import { runWorkflow } from "../services/workflowService.js";
import { createLogger, loggingStorage } from "../utils/logger.js";

const logger = createLogger("Worker");

process.on("message", async (workflowData) => {
  await loggingStorage.run({ title: workflowData.title }, async () => {
    try {
      logger.info("Worker started for workflow:", workflowData.title);

    const result = await runWorkflow(workflowData);

    if (process.send) {
      process.send({ status: "success", result });
    }

      logger.info("Worker completed successfully.");
      process.exit(0);
    } catch (err) {
      logger.error("Worker failed:", err.message);
      if (process.send) {
        process.send({ status: "error", error: err.message });
      }
      process.exit(1);
    }
  });
});
