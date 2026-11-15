declare const process: { exitCode: number };
import { createDamageWorkflow } from "./events-workflow";

async function main() {
  const workflow = createDamageWorkflow(100);
  try {
    console.log(await workflow.apply(15));
    console.log(await workflow.apply(25));
    console.log(await workflow.apply(0));
  } finally { workflow.dispose(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
