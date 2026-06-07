export const PROMPTS = {
  ANIME: [
    'GOKU',
    'NARUTO',
    'GOJO',
    'ITACHI',
    'LUFFY',
    'EREN',
    'TANJIRO',
    'ZENITSU',
    'VEGETA',
    'SASUKE',
  ],

  CARTOON: [
    'SPONGEBOB',
    'SHREK',
    'MINION',
    'TOM',
    'JERRY',
    'BEN10',
    'OGGY',
    'POPEYE',
    'DORAEMON',
    'PATRICK',
  ],

  GAMING: [
    'MARIO',
    'SONIC',
    'KRATOS',
    'LINK',
    'STEVE',
    'LUIGI',
    'PACMAN',
    'MASTER_CHIEF',
    'DONKEY_KONG',
    'MEGA_MAN',
  ],

  RANDOM: [
    'ROBOT',
    'AIRPLANE',
    'VOLCANO',
    'ASTRONAUT',
    'ELEPHANT',
    'TRACTOR',
    'CASTLE',
    'DRAGON',
    'PIZZA',
    'PIRATE',
  ],
} as const;

export type PromptTheme = keyof typeof PROMPTS;
