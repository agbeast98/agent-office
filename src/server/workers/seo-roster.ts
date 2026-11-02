import type { WorkerInfo } from '../../shared/protocol.js';

/** The SEO floor's staff identities, in desk order. */
export const SEO_ROSTER: Readonly<Record<string, { name: string; role: string }>> = {
  'desk-1': { name: 'علیرضا احمدی', role: 'مدیر و هماهنگ‌کنندهٔ تیم سئو' },
  'desk-2': { name: 'نیما فرهمند', role: 'بازبین امنیت و کیفیت' },
  'desk-3': { name: 'آوا رضایی', role: 'متخصص فنی سرچ کنسول' },
  'desk-4': { name: 'امیرحسین رستگار', role: 'متخصص سئوی تصاویر' },
  'desk-5': { name: 'سارا نادری', role: 'پژوهشگر کلمات کلیدی و مربی سئو' },
  'desk-6': { name: 'نگار کاظمی', role: 'راستی‌آزمای خبر و منبع' },
  'desk-7': { name: 'مهدی شریفی', role: 'ویراستار و بازبین کیفیت محتوا' },
  'desk-8': { name: 'رها کریمی', role: 'راهبردپرداز ویدئو و شبکه‌های اجتماعی' },
  'desk-9': { name: 'نازنین مرادی', role: 'مسئول آموزش و مستندسازی فرایندهای سئو' },
  'desk-10': { name: 'بهنام موسوی', role: 'نویسنده و بهینه‌ساز مقاله' },
  'desk-11': { name: 'مهسا فرهمند', role: 'نویسندهٔ محتوای تجاری و راهنمای خرید' },
  'desk-12': { name: 'پیمان حیدری', role: 'بازبین محتوای تجاری و راهنمای خرید' },
};

export function withSeoIdentity(info: WorkerInfo): WorkerInfo {
  const profile = SEO_ROSTER[info.deskId];
  if (!profile || info.kind !== 'agent' || info.meeting) return info;
  return { ...info, ...profile };
}
