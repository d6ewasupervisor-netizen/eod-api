// Blitz Kompass ISE — project id used for Checklane hub schedule sync/display.

const BLITZ_PROJECT_ID = Number(process.env.CHECKLANES_BLITZ_PROJECT_ID || 1715);
const BLITZ_PROJECT_NAME = 'Fred Meyer Blitz Kompass ISE';

module.exports = {
  BLITZ_PROJECT_ID,
  BLITZ_PROJECT_NAME,
};
