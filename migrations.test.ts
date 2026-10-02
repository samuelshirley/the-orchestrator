import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./store";

// These are what the live dossier recorded in _bb_migrations: bb stores each
// applied migration as the sha256 of its exact statement, by index. Never
// change or reorder a migration; only append, then pin its hash here.
const PINNED = [
  "a176c314ae524351e77c35a568404bb6932d39ef39b1571f2839d547e27e609e", // 0 meta
  "8b7403bee160202331bc63dbb99264f97830ed5d10fe2e2f5b8210e9e47acf5c", // 1 project_prefs
  "93ad8c77d89c041c7e261fee0ed9ce3d4b7249e79dfa25483c66a93bbc2cd0aa", // 2 tasks
  "21453b5a2437edcb31669008451273b8d9f871632a5d9ddefacb48bf3e48cd3b", // 3 claims
  "7597a84bc347136d60344a98199ca7ff983db09b95262ca8b99a473bee63d446", // 4 tickets
  "0f2df14d74df0677de44dc6b6774f307255e7458582a66563d4bbc17d6830f3b", // 5 children
  "e40ccc89811490355deea5133f2442c54613b3f4f467e652bc37fde5fc87761f", // 6 tasks.build_failures
  "98c6a942d954162cbe2334c403693ee5222c31d8099b30fc1182b948e51f5a40", // 7 tasks.build_request
  "851409c4a0213d9af6b2461c9ce8290b29ed86ab295376e0a759ea41130ddb91", // 8 tickets.asks
  "9db3c69f3640296766663169822bf74b3be2fe964aeaae1fc8d432f3c85bb496", // 9 tasks.head_sha
  "24ca67a823fe4ce485fa1ce6737a83cdda192d974cb57dca418a75a4d7fc2e1a", // 10 releases
  "51f661313e78bb831ebae95d1f4ab6c88c77d6d66e99b604731cd921df72f270", // 11 browser_lease
  "0ef1bb7f951d87a51ef5041c29b3c9881a30c7edcc9015d8679ae5364167bfbc", // 12 tasks.labelled_sha
  "74450a391df7e688575feff6ad87bbc7be33704a8156fefa3b08f5b73d2371b3", // 13 withdrawals
  "02089522acb15463c183179e0c622b51c8110ca2a18c01165cd04cf64ba31676", // 14 jev_watch
  "0a3a9a2b73905e40ba8384d370280886f25cd18d033df563925ce963b8da9e85", // 15 jev_watch index
  "c4d89e7f19acac46b600537e2998ff8254db6fd29384473e445dd0f94e190589", // 16 model_routes
];

const sha256 = (statement: string) => createHash("sha256").update(statement).digest("hex");

describe("MIGRATIONS", () => {
  it("keeps every recorded migration", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(PINNED.length);
  });

  it.each(PINNED.map((hash, index) => [index, hash] as const))(
    "migration %i keeps its recorded statement",
    (index, hash) => {
      expect(sha256(MIGRATIONS[index])).toBe(hash);
    },
  );
});
