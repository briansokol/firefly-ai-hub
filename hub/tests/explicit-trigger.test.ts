import { describe, it, expect } from 'vitest';
import { extractExplicitMemory } from '../src/memory/explicit-trigger.js';

describe('extractExplicitMemory', () => {
  describe('positive matches', () => {
    it.each([
      ['remember that I prefer dark mode', 'I prefer dark mode'],
      ['Remember that I prefer dark mode', 'I prefer dark mode'],
      ['remember this: my cat is named Fluffy', 'my cat is named Fluffy'],
      ['remember: the meeting is at 3pm', 'the meeting is at 3pm'],
      ['remember, my birthday is Jan 1', 'my birthday is Jan 1'],
      ['remember my favorite color is blue', 'my favorite color is blue'],
      ['please remember that I like coffee', 'I like coffee'],
      ['Please remember I work remote Fridays', 'I work remote Fridays'],
      ['hey, remember my dentist appointment is Tuesday', 'my dentist appointment is Tuesday'],
      ['note that I use Arch Linux', 'I use Arch Linux'],
      ["don't forget I prefer metric units", 'I prefer metric units'],
      ['dont forget I prefer metric units', 'I prefer metric units'],
      ["don't forget that I prefer metric units", 'I prefer metric units'],
      ['save this: my password hint is blue', 'my password hint is blue'],
      ['make a note that I work remote Fridays', 'I work remote Fridays'],
      ['make a note I work remote Fridays', 'I work remote Fridays'],
    ])('extracts fact from %j', (input, expected) => {
      expect(extractExplicitMemory(input)).toEqual({ content: expected });
    });

    it('strips a trailing period', () => {
      expect(extractExplicitMemory('remember that I like coffee.')).toEqual({
        content: 'I like coffee',
      });
    });

    it('strips trailing exclamation marks', () => {
      expect(extractExplicitMemory('remember I love pizza!!!')).toEqual({
        content: 'I love pizza',
      });
    });
  });

  describe('negative matches — must NOT save', () => {
    it.each([
      'I remember when I was a kid',
      'do you remember my favorite song?',
      "I'll remember that for later",
      'let me remember to call you',
      'tell me about remember the titans',
      'I cannot remember my password',
      'she will remember the answer',
      'what do you remember about our last chat?',
      'you should remember this is important',
      'I noted that it was raining',
      'the note said to call back',
      'tell me a joke',
      'what time is it',
      'hello how are you',
    ])('ignores %j', (input) => {
      expect(extractExplicitMemory(input)).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns null for empty input', () => {
      expect(extractExplicitMemory('')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      expect(extractExplicitMemory('   ')).toBeNull();
    });

    it('returns null when the fact body is empty', () => {
      expect(extractExplicitMemory('remember')).toBeNull();
      expect(extractExplicitMemory('remember that')).toBeNull();
      expect(extractExplicitMemory('remember that.')).toBeNull();
      expect(extractExplicitMemory("don't forget")).toBeNull();
    });

    it('returns null when the fact is too short to be meaningful', () => {
      expect(extractExplicitMemory('remember x')).toBeNull();
      expect(extractExplicitMemory('remember me')).toBeNull();
    });
  });
});
