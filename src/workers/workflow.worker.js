// workflow.worker.js
import { runWorkflow } from "../services/workflowService.js";

(async () => {
    try {
        const workflowData = JSON.parse(process.argv[2]);
        console.log("Worker started for workflow:", workflowData);

        await runWorkflow(workflowData);

        console.log("Worker completed successfully.");
        process.exit(0);
    } catch (err) {
        console.error("Worker failed:", err.message);
        process.exit(1);
    }
})();
