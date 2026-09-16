export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AfterActivate } from '@gitroom/frontend/components/auth/after.activate';
import { BRAND_NAME } from '@gitroom/helpers/utils/branding';
export const metadata: Metadata = {
  title: `${BRAND_NAME} - Activate your account`,
  description: '',
};
export default async function Auth() {
  return <AfterActivate />;
}
