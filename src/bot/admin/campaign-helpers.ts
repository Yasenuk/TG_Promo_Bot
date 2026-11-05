import type { AppContext } from '../context.js';
import { campaignRepo } from '../../db/repositories/campaign.repo.js';

export async function replyCampaignNotFound(
  ctx: AppContext,
  slug: string,
): Promise<void> {
  const campaigns = await campaignRepo.listAll();

  if (campaigns.length === 0) {
    await ctx.reply(
      `❌ Кампанії «${slug}» немає - як і жодної іншої.\n\n` +
        'Створити першу (у терміналі, бо там JSON із правилами):\n\n' +
        '<code>npm run campaign:create -- --slug=name --title="title" \\\n' +
        '  --prefix=XX --rules=./rules/<slug>.json --prizes=./rules/<slug>-prizes.json</code>\n\n' +
        'Далі: /bind_topic <slug> → надішли файл із кодами → /campaign activate <slug>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const list = campaigns
    .map((c) => `${c.status === 'ACTIVE' ? '🟢' : '⚪️'} <code>${c.slug}</code> - ${c.title}`)
    .join('\n');

  await ctx.reply(`❌ Кампанії «${slug}» немає.\n\n<b>Наявні:</b>\n${list}`, {
    parse_mode: 'HTML',
  });
}
