import { describe, expect, it } from 'vitest';
import { drawService, type Ticket } from '../../../src/domain/draw/draw.service.js';

function makeTickets(users: number, codesPerUser: (i: number) => number): Ticket[] {
  const tickets: Ticket[] = [];

  for (let u = 0; u < users; u++) {
    for (let c = 0; c < codesPerUser(u); c++) {
      tickets.push({
        activationId: `act-${u}-${c}`,
        userId: `user-${u}`,
        fullName: `Учасник ${u}`,
        phone: `+38067000${String(u).padStart(4, '0')}`,
        telegramId: BigInt(1000 + u),
        codeValue: `CODE${u}${c}`,
      });
    }
  }

  return tickets;
}

const PRIZES = [
  { key: 'tv', title: 'Телевізор', count: 1 },
  { key: 'phone', title: 'Телефон', count: 3 },
];

describe('drawService.plan', () => {
  const tickets = makeTickets(50, () => 2);

  it('детермінований: той самий seed - ті самі переможці', () => {
    const a = drawService.plan(tickets, PRIZES, 'fixed-seed', { uniqueWinners: true });
    const b = drawService.plan(tickets, PRIZES, 'fixed-seed', { uniqueWinners: true });

    expect(a.winners.map((w) => w.activationId)).toEqual(
      b.winners.map((w) => w.activationId),
    );
  });

  it('інший seed - інший результат', () => {
    const a = drawService.plan(tickets, PRIZES, 'seed-1', { uniqueWinners: true });
    const b = drawService.plan(tickets, PRIZES, 'seed-2', { uniqueWinners: true });

    expect(a.winners.map((w) => w.activationId)).not.toEqual(
      b.winners.map((w) => w.activationId),
    );
  });

  it('видає рівно стільки призів, скільки замовлено', () => {
    const plan = drawService.plan(tickets, PRIZES, 's', { uniqueWinners: true });
    expect(plan.winners).toHaveLength(4);
    expect(plan.winners.filter((w) => w.prizeKey === 'tv')).toHaveLength(1);
    expect(plan.winners.filter((w) => w.prizeKey === 'phone')).toHaveLength(3);
  });

  it('uniqueWinners: одна людина не виграє двічі', () => {
    const plan = drawService.plan(tickets, PRIZES, 's', { uniqueWinners: true });
    const userIds = plan.winners.map((w) => w.userId);
    expect(new Set(userIds).size).toBe(userIds.length);
  });

  it('allow-repeat: та сама людина може виграти кілька разів', () => {
    const few = makeTickets(2, () => 5);
    const plan = drawService.plan(few, PRIZES, 's', { uniqueWinners: false });
    expect(plan.winners).toHaveLength(4);
  });

  it('учасників менше, ніж призів - видає скільки може, без падіння', () => {
    const few = makeTickets(2, () => 1);
    const plan = drawService.plan(few, PRIZES, 's', { uniqueWinners: true });
    expect(plan.winners.length).toBeLessThanOrEqual(2);
  });

  it('порожній список квитків не ламає планування', () => {
    const plan = drawService.plan([], PRIZES, 's', { uniqueWinners: true });
    expect(plan.winners).toHaveLength(0);
    expect(plan.totalTickets).toBe(0);
  });

  it('рахує квитки й унікальних учасників окремо', () => {
    const mixed = makeTickets(10, (i) => i + 1); // 1+2+…+10 = 55
    const plan = drawService.plan(mixed, PRIZES, 's', { uniqueWinners: true });

    expect(plan.totalTickets).toBe(55);
    expect(plan.uniqueParticipants).toBe(10);
  });
});

describe('чесність розподілу', () => {
  /**
   * Ключова властивість механіки: 1 код = 1 квиток.
   * Людина з 10 кодами має вигравати приблизно вдесятеро частіше.
   */
  it('шанси пропорційні кількості кодів', () => {
    // user-0: 1 код, user-1: 10 кодів
    const tickets = makeTickets(2, (i) => (i === 0 ? 1 : 10));
    const single = [{ key: 'tv', title: 'ТВ', count: 1 }];

    let winsUser1 = 0;
    const runs = 2000;

    for (let i = 0; i < runs; i++) {
      const plan = drawService.plan(tickets, single, `seed-${i}`, {
        uniqueWinners: true,
      });
      if (plan.winners[0]?.userId === 'user-1') winsUser1++;
    }

    // Очікуємо ~10/11 ≈ 91%. Допуск широкий, щоб тест не блимав.
    const share = winsUser1 / runs;
    expect(share).toBeGreaterThan(0.85);
    expect(share).toBeLessThan(0.96);
  });
});
