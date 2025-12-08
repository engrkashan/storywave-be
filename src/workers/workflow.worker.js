// workflow.worker.js
import { runWorkflow } from "../services/workflowService.js";

process.on("message", async (workflowData) => {
  try {
    console.log("Worker started for workflow:", workflowData.title);

    const result = await runWorkflow(workflowData);

    if (process.send) {
      process.send({ status: "success", result });
    }

    console.log("Worker completed successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Worker failed:", err.message);
    if (process.send) {
      process.send({ status: "error", error: err.message });
    }
    process.exit(1);
  }
});
