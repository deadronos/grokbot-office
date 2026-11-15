import { describe, expect, it } from "vitest";

import { botRecord } from "../test-utils.ts";
import { toBotSnapshot } from "./mappers.ts";

describe("toBotSnapshot pod", () => {
  it("takes the pod from the layout desk", () => {
    // A stored row that disagrees with the layout: the layout is canonical.
    const snapshot = toBotSnapshot({ ...botRecord("data"), pod: "ops" }, undefined);
    expect(snapshot.pod).toBe("dev");
    expect(snapshot.desk?.botId).toBe("data");
  });

  it("keeps the stored pod for a bot outside the layout", () => {
    const snapshot = toBotSnapshot({ ...botRecord("helper"), pod: "ops" }, undefined);
    expect(snapshot.pod).toBe("ops");
    expect(snapshot.desk).toBeUndefined();
  });
});
