/**
 * The files of the kit's golden message fixtures (PRO-110), as the generator writes them: one file
 * of valid and invalid frames per message type, and the conversation of 05 §5.9.
 */
import { DEP1 } from '@docedit/protocol';
import { conversationFixture, messageFixtures } from './messages.ts';

export interface FixtureFile {
  path: string;
  text: string;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export function fixtureFiles(): FixtureFile[] {
  return [
    {
      path: 'fixtures/messages/messages.json',
      text: json({
        description:
          'Golden message fixtures of DEP 1.0 (PRO-110): for every message type, valid frames (required members only; every member) and invalid ones. A receiver accepts every valid frame and refuses every invalid one: `fatal` frames close the connection with 4400, the others are answered with a non-fatal bad_message (decision D03).',
        protocol: DEP1.version,
        generator: 'packages/tck/scripts/generate.ts',
        messages: messageFixtures(),
      }),
    },
    {
      path: 'fixtures/messages/conversation.json',
      text: json({
        protocol: DEP1.version,
        generator: 'packages/tck/scripts/generate.ts',
        ...conversationFixture(),
      }),
    },
  ];
}
