import { Logger } from '@nestjs/common';
import { TelegramErrorLogger, scrub, signature } from './telegram-error-logger';

describe('TelegramErrorLogger', () => {
  let sent: string[];
  let logger: TelegramErrorLogger;

  beforeEach(() => {
    sent = [];
    logger = new TelegramErrorLogger((html) => sent.push(html));
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => jest.restoreAllMocks());

  it('posts a service logger error with its context', () => {
    Logger.overrideLogger(logger);
    new Logger('AutoCompoundService').error(
      '[auto-compound] GCZVDRMNHKCWPJOKW6KR4BXLQWOKWNYZC2DOKSPRFEDG7XOGRBKLCTRX failed (5x): Bad union switch: 1',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('AutoCompoundService');
    expect(sent[0]).toContain('Bad union switch: 1');
  });

  it('posts a repeated error once per hour and counts the held repeats', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    for (let i = 0; i < 5; i++) logger.report('Poll', `Request failed with status code 50${i % 2}`);
    expect(sent).toHaveLength(1);
    now.mockReturnValue(1_000_000 + 61 * 60_000);
    logger.report('Poll', 'Request failed with status code 502');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('+4 more');
  });

  it('caps total posts per hour', () => {
    jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
    for (let i = 0; i < 50; i++) logger.report(`ctx${i}`, 'boom');
    expect(sent).toHaveLength(30);
  });

  it('captures console.error', () => {
    const original = console.error;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.captureConsoleErrors();
    console.error('POL deposit failed:', new Error('timeout'));
    console.error = original;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('POL deposit failed');
  });

  it('never sends secrets', () => {
    const secret = 'S' + 'A'.repeat(55);
    const out = scrub(`bot123456:${'x'.repeat(35)} key ${secret}`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain('x'.repeat(35));
  });

  it('groups errors that differ only by numbers, hashes and addresses', () => {
    expect(signature('tx a1b2c3d4e5f6a7b8c9d0 failed at ledger 65198163')).toBe(
      signature('tx ffffffffffffffffffff failed at ledger 1'),
    );
  });
});
