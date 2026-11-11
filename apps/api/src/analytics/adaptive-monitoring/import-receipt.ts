import { readFileSync, statSync } from "node:fs";
import { ClimateDatabase } from "../../db.js";
import { isAdaptivePromotionReceipt } from "@climate-twin/contracts";
import { AdaptiveMonitoringStore } from "./store.js";
import { assertPromotion } from "./scope.js";
import { privateAdaptivePath } from "./private-path.js";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--database" || args[2] !== "--receipt" || !args[1] || !args[3]) {
  throw new Error("Usage: npm run adaptive:import-receipt -- --database ABSOLUTE_DATABASE --receipt ABSOLUTE_RECEIPT_OUTSIDE_GIT");
}
const databasePath = privateAdaptivePath(args[1]);
const receiptPath = privateAdaptivePath(args[3]);
const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
if (!isAdaptivePromotionReceipt(receipt) || receipt.dataMode !== "live" || ("canPromote" in receipt && receipt.canPromote === false)) {
  throw new Error("A reviewed prospective live-data receipt is required; synthetic evaluations cannot promote advisory mode");
}
if (!statSync(databasePath).isFile()) throw new Error("Use an existing installation database");
const database = new ClimateDatabase(databasePath);
try {
  if (!database.isRealDataMode()) throw new Error("The database is not in live mode");
  database.transaction(() => {
    database.db.prepare("INSERT INTO adaptive_promotion_receipts VALUES(?,?)").run(receipt.id, JSON.stringify(receipt));
    assertPromotion(new AdaptiveMonitoringStore(database), receipt.id, "live");
    new AdaptiveMonitoringStore(database).audit("installation", { actor: "local-operator",
      now: new Date().toISOString(), action: "import-evaluation", detail: { receiptId: receipt.id, configurationDigest: receipt.configurationDigest } });
  });
  process.stdout.write(`Imported evaluation ${receipt.id}. Advisory remains off until an Owner/Admin selects it for a qualified Home.\n`);
} finally { database.close(); }
