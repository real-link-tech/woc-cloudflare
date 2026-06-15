import { clerkSetup } from '@clerk/testing/playwright';

// clerkSetup reads CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY from the environment
// and mints a Clerk testing token so Playwright can drive sign-in headlessly.
export default async function globalSetup() {
  await clerkSetup();
}
