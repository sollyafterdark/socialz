import { ThirdPartyComponent } from '@gitroom/frontend/components/third-parties/third-party.component';

export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { BRAND_NAME } from '@gitroom/helpers/utils/branding';
export const metadata: Metadata = {
  title: `${BRAND_NAME} Integrations`,
  description: '',
};
export default async function Index() {
  return <ThirdPartyComponent />;
}
