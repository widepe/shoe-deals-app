// lib/apifyRoadRunner.ts
import { ApifyClient } from 'apify-client';

export interface Deal {
  title: string;
  brand: string;
  model: string;
  price: number | null;
  originalPrice: number | null;
  store: string;
  url: string;
  image: string | null;
  discount: string | null;
  scrapedAt: string;
}

const client = new ApifyClient({
  token: process.env.APIFY_TOKEN!,
});

/**
 * Runs the Road Runner Apify actor and returns its dataset as Deal[].
 */
export async function fetchRoadRunnerDeals(): Promise<Deal[]> {
  if (!process.env.APIFY_ROADRUNNER_ACTOR_ID) {
    throw new Error('APIFY_ROADRUNNER_ACTOR_ID is not set');
  }

  // 1. Start a run of your Apify actor and wait for it to finish
  const run = await client
    .actor(process.env.APIFY_ROADRUNNER_ACTOR_ID)
    .call({});

  // 2. Read ALL items from the default dataset for this run
  const allItems: Deal[] = [];
  let offset = 0;
  const limit = 500; // plenty for Road Runner sale pages

  while (true) {
    const { items, total } = await client
      .dataset(run.defaultDatasetId)
      .listItems<Deal>({ offset, limit });

    allItems.push(...items);

    offset += items.length;
    if (offset >= total || items.length === 0) break;
  }

  // Safety: ensure store is set
  for (const d of allItems) {
    if (!d.store) d.store = 'Road Runner Sports';
  }

  return allItems;
}
