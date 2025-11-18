import prisma from "../config/prisma.client.js";
import { runWorkflowSteps } from "../services/workflowSteps.js";

export async function runScheduledWorkflows() {
  const now = new Date();

  const dueWorkflows = await prisma.workflow.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lte: now }
    }
  });

  if (dueWorkflows.length === 0) return;

  console.log(`Found ${dueWorkflows.length} scheduled workflows to run.`);

  for (const workflow of dueWorkflows) {
    try {
      await prisma.workflow.update({
        where: { id: workflow.id },
        data: { status: "PROCESSING" }
      });

      await runWorkflowSteps(workflow);

      await prisma.workflow.update({
        where: { id: workflow.id },
        data: { status: "COMPLETED" }
      });

      console.log(`Workflow ${workflow.id} completed.`);
    } catch (error) {
      console.error(`Workflow ${workflow.id} failed:`, error.message);

      await prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          status: "FAILED",
          metadata: { error: error.message }
        }
      });
    }
  }
}
