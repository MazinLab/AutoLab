import {
  expect,
  test as base,
  type APIRequestContext,
} from "@playwright/test";

import { ACTOR_STORAGE_KEY } from "../src/api/client";

export interface CreatedEntity {
  accession: string;
  id: string;
  name: string;
}

export async function createApiEntity(
  request: APIRequestContext,
  entityType: string,
  data: Record<string, unknown>,
): Promise<CreatedEntity> {
  const response = await request.post(`/api/${entityType}`, { data });
  expect(response).toBeOK();
  return (await response.json()) as CreatedEntity;
}

export const test = base.extend<{ actorSession: void }>({
  actorSession: [
    async ({ page, request }, use) => {
      const actor = await createApiEntity(request, "agent", {
        name: "Playwright smoke actor",
      });
      await page.addInitScript(
        ({ actorId, storageKey }) => {
          window.localStorage.setItem(storageKey, actorId);
        },
        { actorId: actor.id, storageKey: ACTOR_STORAGE_KEY },
      );
      await use();
    },
    { auto: true },
  ],
});

export { expect };
