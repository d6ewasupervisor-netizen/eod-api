/**
 * Fiscal Calendar Module
 * 
 * Duplicate of flow-automation/src/lib/fiscal-calendar.js for the Railway
 * eod-api bundle — merge calendar updates from that file into this copy.
 * 
 * Handles fiscal year period/week mapping and dump bin path resolution.
 * 
 * Kroger/Fred Meyer Fiscal Calendar:
 * - 13 periods per fiscal year
 * - 4 weeks per period (28 days per period)
 * - Fiscal year typically starts in early February
 * - P13W4 wraps to P01W1 of the next fiscal year
 */

const path = require('path');

/**
 * Fiscal Year Calendar Definitions
 * 
 * Each fiscal year maps period/weeks to their date ranges.
 * This data is derived from the dump bin folder structure.
 */
const FISCAL_CALENDARS = {
  2025: {
    dumpBinPath: '2025 Dump Bin',
    startDate: new Date('2025-02-02'),
    endDate: new Date('2026-01-31'),
    periods: {
      '01': { name: 'Period 01 - 2.2.2025 to 3.1.2025', weeks: {
        '1': { start: '2025-02-02', end: '2025-02-08', folder: 'P01W1 - 2.2.2025 to 2.8.2025' },
        '2': { start: '2025-02-09', end: '2025-02-15', folder: 'P01W2 - 2.9.2025 to 2.15.2025' },
        '3': { start: '2025-02-16', end: '2025-02-22', folder: 'P01W3 - 2.16.2025 to 2.22.2025' },
        '4': { start: '2025-02-23', end: '2025-03-01', folder: 'P01W4 - 2.23.2025 to 3.1.2025' }
      }},
      '02': { name: 'Period 02 - 3.2.2025 to 3.29.2025', weeks: {
        '1': { start: '2025-03-02', end: '2025-03-08', folder: 'P02W1 - 3.2.2025 to 3.8.2025' },
        '2': { start: '2025-03-09', end: '2025-03-15', folder: 'P02W2 - 3.9.2025 to 3.15.2025' },
        '3': { start: '2025-03-16', end: '2025-03-22', folder: 'P02W3 - 3.16.2025 to 3.22.2025' },
        '4': { start: '2025-03-23', end: '2025-03-29', folder: 'P02W4 - 3.23.2025 to 3.29.2025' }
      }},
      '03': { name: 'Period 03 - 3.30.2025 to 4.26.2025', weeks: {
        '1': { start: '2025-03-30', end: '2025-04-05', folder: 'P03W1 - 3.30.2025 to 4.5.2025' },
        '2': { start: '2025-04-06', end: '2025-04-12', folder: 'P03W2 - 4.6.2025 to 4.12.2025' },
        '3': { start: '2025-04-13', end: '2025-04-19', folder: 'P03W3 - 4.13.2025 to 4.19.2025' },
        '4': { start: '2025-04-20', end: '2025-04-26', folder: 'P03W4 - 4.20.2025 to 4.26.2025' }
      }},
      '04': { name: 'Period 04 - 4.27.2025 to 5.24.2025', weeks: {
        '1': { start: '2025-04-27', end: '2025-05-03', folder: 'P04W1 - 4.27.2025 to 5.3.2025' },
        '2': { start: '2025-05-04', end: '2025-05-10', folder: 'P04W2 - 5.4.2025 to 5.10.2025' },
        '3': { start: '2025-05-11', end: '2025-05-17', folder: 'P04W3 - 5.11.2025 to 5.17.2025' },
        '4': { start: '2025-05-18', end: '2025-05-24', folder: 'P04W4 - 5.18.2025 to 5.24.2025' }
      }},
      '05': { name: 'Period 05 - 5.25.2025 to 6.21.2025', weeks: {
        '1': { start: '2025-05-25', end: '2025-05-31', folder: 'P05W1 - 5.25.2025 to 5.31.2025' },
        '2': { start: '2025-06-01', end: '2025-06-07', folder: 'P05W2 - 6.1.2025 to 6.7.2025' },
        '3': { start: '2025-06-08', end: '2025-06-14', folder: 'P05W3 - 6.8.2025 to 6.14.2025' },
        '4': { start: '2025-06-15', end: '2025-06-21', folder: 'P05W4 - 6.15.2025 to 6.21.2025' }
      }},
      '06': { name: 'Period 06 - 6.22.2025 to 7.19.2025', weeks: {
        '1': { start: '2025-06-22', end: '2025-06-28', folder: 'P06W1 - 6.22.2025 to 6.28.2025' },
        '2': { start: '2025-06-29', end: '2025-07-05', folder: 'P06W2 - 6.29.2025 to 7.5.2025' },
        '3': { start: '2025-07-06', end: '2025-07-12', folder: 'P06W3 - 7.6.2025 to 7.12.2025' },
        '4': { start: '2025-07-13', end: '2025-07-19', folder: 'P06W4 - 7.13.2025 to 7.19.2025' }
      }},
      '07': { name: 'Period 07 - 7.20.2025 to 8.16.2025', weeks: {
        '1': { start: '2025-07-20', end: '2025-07-26', folder: 'P07W1 - 7.20.2025 to 7.26.2025' },
        '2': { start: '2025-07-27', end: '2025-08-02', folder: 'P07W2 - 7.27.2025 to 8.2.2025' },
        '3': { start: '2025-08-03', end: '2025-08-09', folder: 'P07W3 - 8.3.2025 to 8.9.2025' },
        '4': { start: '2025-08-10', end: '2025-08-16', folder: 'P07W4 - 8.10.2025 to 8.16.2025' }
      }},
      '08': { name: 'Period 08 - 8.17.2025 to 9.13.2025', weeks: {
        '1': { start: '2025-08-17', end: '2025-08-23', folder: 'P08W1 - 8.17.2025 to 8.23.2025' },
        '2': { start: '2025-08-24', end: '2025-08-30', folder: 'P08W2 - 8.24.2025 to 8.30.2025' },
        '3': { start: '2025-08-31', end: '2025-09-06', folder: 'P08W3 - 8.31.2025 to 9.6.2025' },
        '4': { start: '2025-09-07', end: '2025-09-13', folder: 'P08W4 - 9.7.2025 to 9.13.2025' }
      }},
      '09': { name: 'Period 09 - 9.14.2025 to 10.11.2025', weeks: {
        '1': { start: '2025-09-14', end: '2025-09-20', folder: 'P09W1 - 9.14.2025 to 9.20.2025' },
        '2': { start: '2025-09-21', end: '2025-09-27', folder: 'P09W2 - 9.21.2025 to 9.27.2025' },
        '3': { start: '2025-09-28', end: '2025-10-04', folder: 'P09W3 - 9.28.2025 to 10.4.2025' },
        '4': { start: '2025-10-05', end: '2025-10-11', folder: 'P09W4 - 10.5.2025 to 10.11.2025' }
      }},
      '10': { name: 'Period 10 - 10.12.2025 to 11.8.2025', weeks: {
        '1': { start: '2025-10-12', end: '2025-10-18', folder: 'P10W1 - 10.12.2025 to 10.18.2025' },
        '2': { start: '2025-10-19', end: '2025-10-25', folder: 'P10W2 - 10.19.2025 to 10.25.2025' },
        '3': { start: '2025-10-26', end: '2025-11-01', folder: 'P10W3 - 10.26.2025 to 11.1.2025' },
        '4': { start: '2025-11-02', end: '2025-11-08', folder: 'P10W4 - 11.2.2025 to 11.8.2025' }
      }},
      '11': { name: 'Period 11 - 11.9.2025 to 12.6.2025', weeks: {
        '1': { start: '2025-11-09', end: '2025-11-15', folder: 'P11W1 - 11.9.2025 to 11.15.2025' },
        '2': { start: '2025-11-16', end: '2025-11-22', folder: 'P11W2 - 11.16.2025 to 11.22.2025' },
        '3': { start: '2025-11-23', end: '2025-11-29', folder: 'P11W3 - 11.23.2025 to 11.29.2025' },
        '4': { start: '2025-11-30', end: '2025-12-06', folder: 'P11W4 - 11.30.2025 to 12.6.2025' }
      }},
      '12': { name: 'Period 12 - 12.7.2025 to 1.3.2026', weeks: {
        '1': { start: '2025-12-07', end: '2025-12-13', folder: 'P12W1 - 12.7.2025 to 12.13.2025' },
        '2': { start: '2025-12-14', end: '2025-12-20', folder: 'P12W2 - 12.14.2025 to 12.20.2025' },
        '3': { start: '2025-12-21', end: '2025-12-27', folder: 'P12W3 - 12.21.2025 to 12.27.2025' },
        '4': { start: '2025-12-28', end: '2026-01-03', folder: 'P12W4 - 12.28.2025 to 1.3.2026' }
      }},
      '13': { name: 'Period 13 - 1.4.2026 to 1.31.2026', weeks: {
        '1': { start: '2026-01-04', end: '2026-01-10', folder: 'P13W1 - 1.4.2026 to 1.10.2026' },
        '2': { start: '2026-01-11', end: '2026-01-17', folder: 'P13W2 - 1.11.2026 to 1.17.2026' },
        '3': { start: '2026-01-18', end: '2026-01-24', folder: 'P13W3 - 1.18.2026 to 1.24.2026' },
        '4': { start: '2026-01-25', end: '2026-01-31', folder: 'P13W4 - 1.25.2026 to 1.31.2026' }
      }}
    }
  },
  2026: {
    dumpBinPath: '2026 Dump Bin',
    startDate: new Date('2026-02-01'),
    endDate: new Date('2027-01-30'),
    periods: {
      '01': { name: 'Period 01 - 2.1.2026 to 2.28.2026', weeks: {
        '1': { start: '2026-02-01', end: '2026-02-07', folder: 'P01W1 - 2.1.2026 to 2.7.2026' },
        '2': { start: '2026-02-08', end: '2026-02-14', folder: 'P01W2 - 2.8.2026 to 2.14.2026' },
        '3': { start: '2026-02-15', end: '2026-02-21', folder: 'P01W3 - 2.15.2026 to 2.21.2026' },
        '4': { start: '2026-02-22', end: '2026-02-28', folder: 'P01W4 - 2.22.2026 to 2.28.2026' }
      }},
      '02': { name: 'Period 02 - 3.1.2026 to 3.28.2026', weeks: {
        '1': { start: '2026-03-01', end: '2026-03-07', folder: 'P02W1 - 3.1.2026 to 3.7.2026' },
        '2': { start: '2026-03-08', end: '2026-03-14', folder: 'P02W2 - 3.8.2026 to 3.14.2026' },
        '3': { start: '2026-03-15', end: '2026-03-21', folder: 'P02W3 - 3.15.2026 to 3.21.2026' },
        '4': { start: '2026-03-22', end: '2026-03-28', folder: 'P02W4 - 3.22.2026 to 3.28.2026' }
      }},
      '03': { name: 'Period 03 - 3.29.2026 to 4.25.2026', weeks: {
        '1': { start: '2026-03-29', end: '2026-04-04', folder: 'P03W1 - 3.29.2026 to 4.4.2026' },
        '2': { start: '2026-04-05', end: '2026-04-11', folder: 'P03W2 - 4.5.2026 to 4.11.2026' },
        '3': { start: '2026-04-12', end: '2026-04-18', folder: 'P03W3 - 4.12.2026 to 4.18.2026' },
        '4': { start: '2026-04-19', end: '2026-04-25', folder: 'P03W4 - 4.19.2026 to 4.25.2026' }
      }},
      '04': { name: 'Period 04 - 4.26.2026 to 5.23.2026', weeks: {
        '1': { start: '2026-04-26', end: '2026-05-02', folder: 'P04W1 - 4.26.2026 to 5.2.2026' },
        '2': { start: '2026-05-03', end: '2026-05-09', folder: 'P04W2 - 5.3.2026 to 5.9.2026' },
        '3': { start: '2026-05-10', end: '2026-05-16', folder: 'P04W3 - 5.10.2026 to 5.16.2026' },
        '4': { start: '2026-05-17', end: '2026-05-23', folder: 'P04W4 - 5.17.2026 to 5.23.2026' }
      }},
      '05': { name: 'Period 05 - 5.24.2026 to 6.20.2026', weeks: {
        '1': { start: '2026-05-24', end: '2026-05-30', folder: 'P05W1 - 5.24.2026 to 5.30.2026' },
        '2': { start: '2026-05-31', end: '2026-06-06', folder: 'P05W2 - 5.31.2026 to 6.6.2026' },
        '3': { start: '2026-06-07', end: '2026-06-13', folder: 'P05W3 - 6.7.2026 to 6.13.2026' },
        '4': { start: '2026-06-14', end: '2026-06-20', folder: 'P05W4 - 6.14.2026 to 6.20.2026' }
      }},
      '06': { name: 'Period 06 - 6.21.2026 to 7.18.2026', weeks: {
        '1': { start: '2026-06-21', end: '2026-06-27', folder: 'P06W1 - 6.21.2026 to 6.27.2026' },
        '2': { start: '2026-06-28', end: '2026-07-04', folder: 'P06W2 - 6.28.2026 to 7.4.2026' },
        '3': { start: '2026-07-05', end: '2026-07-11', folder: 'P06W3 - 7.5.2026 to 7.11.2026' },
        '4': { start: '2026-07-12', end: '2026-07-18', folder: 'P06W4 - 7.12.2026 to 7.18.2026' }
      }},
      '07': { name: 'Period 07 - 7.19.2026 to 8.15.2026', weeks: {
        '1': { start: '2026-07-19', end: '2026-07-25', folder: 'P07W1 - 7.19.2026 to 7.25.2026' },
        '2': { start: '2026-07-26', end: '2026-08-01', folder: 'P07W2 - 7.26.2026 to 8.1.2026' },
        '3': { start: '2026-08-02', end: '2026-08-08', folder: 'P07W3 - 8.2.2026 to 8.8.2026' },
        '4': { start: '2026-08-09', end: '2026-08-15', folder: 'P07W4 - 8.9.2026 to 8.15.2026' }
      }},
      '08': { name: 'Period 08 - 8.16.2026 to 9.12.2026', weeks: {
        '1': { start: '2026-08-16', end: '2026-08-22', folder: 'P08W1 - 8.16.2026 to 8.22.2026' },
        '2': { start: '2026-08-23', end: '2026-08-29', folder: 'P08W2 - 8.23.2026 to 8.29.2026' },
        '3': { start: '2026-08-30', end: '2026-09-05', folder: 'P08W3 - 8.30.2026 to 9.5.2026' },
        '4': { start: '2026-09-06', end: '2026-09-12', folder: 'P08W4 - 9.6.2026 to 9.12.2026' }
      }},
      '09': { name: 'Period 09 - 9.13.2026 to 10.10.2026', weeks: {
        '1': { start: '2026-09-13', end: '2026-09-19', folder: 'P09W1 - 9.13.2026 to 9.19.2026' },
        '2': { start: '2026-09-20', end: '2026-09-26', folder: 'P09W2 - 9.20.2026 to 9.26.2026' },
        '3': { start: '2026-09-27', end: '2026-10-03', folder: 'P09W3 - 9.27.2026 to 10.3.2026' },
        '4': { start: '2026-10-04', end: '2026-10-10', folder: 'P09W4 - 10.4.2026 to 10.10.2026' }
      }},
      '10': { name: 'Period 10 - 10.11.2026 to 11.7.2026', weeks: {
        '1': { start: '2026-10-11', end: '2026-10-17', folder: 'P10W1 - 10.11.2026 to 10.17.2026' },
        '2': { start: '2026-10-18', end: '2026-10-24', folder: 'P10W2 - 10.18.2026 to 10.24.2026' },
        '3': { start: '2026-10-25', end: '2026-10-31', folder: 'P10W3 - 10.25.2026 to 10.31.2026' },
        '4': { start: '2026-11-01', end: '2026-11-07', folder: 'P10W4 - 11.1.2026 to 11.7.2026' }
      }},
      '11': { name: 'Period 11 - 11.8.2026 to 12.5.2026', weeks: {
        '1': { start: '2026-11-08', end: '2026-11-14', folder: 'P11W1 - 11.8.2026 to 11.14.2026' },
        '2': { start: '2026-11-15', end: '2026-11-21', folder: 'P11W2 - 11.15.2026 to 11.21.2026' },
        '3': { start: '2026-11-22', end: '2026-11-28', folder: 'P11W3 - 11.22.2026 to 11.28.2026' },
        '4': { start: '2026-11-29', end: '2026-12-05', folder: 'P11W4 - 11.29.2026 to 12.5.2026' }
      }},
      '12': { name: 'Period 12 - 12.6.2026 to 1.2.2027', weeks: {
        '1': { start: '2026-12-06', end: '2026-12-12', folder: 'P12W1 - 12.6.2026 to 12.12.2026' },
        '2': { start: '2026-12-13', end: '2026-12-19', folder: 'P12W2 - 12.13.2026 to 12.19.2026' },
        '3': { start: '2026-12-20', end: '2026-12-26', folder: 'P12W3 - 12.20.2026 to 12.26.2026' },
        '4': { start: '2026-12-27', end: '2027-01-02', folder: 'P12W4 - 12.27.2026 to 1.2.2027' }
      }},
      '13': { name: 'Period 13 - 1.3.2027 to 1.30.2027', weeks: {
        '1': { start: '2027-01-03', end: '2027-01-09', folder: 'P13W1 - 1.3.2027 to 1.9.2027' },
        '2': { start: '2027-01-10', end: '2027-01-16', folder: 'P13W2 - 1.10.2027 to 1.16.2027' },
        '3': { start: '2027-01-17', end: '2027-01-23', folder: 'P13W3 - 1.17.2027 to 1.23.2027' },
        '4': { start: '2027-01-24', end: '2027-01-30', folder: 'P13W4 - 1.24.2027 to 1.30.2027' }
      }}
    }
  }
};

/**
 * Get the fiscal year for a given period/week
 * 
 * The key insight: P01-P13 exist in both fiscal years, but at different times.
 * We determine fiscal year based on:
 * - If we're currently processing and know the context date
 * - Or by looking at which fiscal year's date range contains today
 * 
 * For the year transition (P13W4 -> P01W1):
 * - P13W4 of FY2025 ends Jan 31, 2026
 * - P01W1 of FY2026 starts Feb 1, 2026
 * 
 * @param {number|string} period - Period number (1-13)
 * @param {number|string} week - Week number (1-4)
 * @param {Date} contextDate - Optional date for context (defaults to today)
 * @returns {number} Fiscal year (2025, 2026, etc.)
 */
function getFiscalYear(period, week, contextDate = null) {
  const periodNum = parseInt(period, 10);
  const weekNum = parseInt(week, 10);
  const today = contextDate || new Date();
  
  // Get the date ranges for both fiscal years to see which one applies
  for (const [fiscalYear, calendar] of Object.entries(FISCAL_CALENDARS)) {
    const fy = parseInt(fiscalYear, 10);
    const periodStr = String(periodNum).padStart(2, '0');
    const weekStr = String(weekNum);
    
    const periodData = calendar.periods[periodStr];
    if (!periodData) continue;
    
    const weekData = periodData.weeks[weekStr];
    if (!weekData) continue;
    
    const weekStart = new Date(weekData.start);
    const weekEnd = new Date(weekData.end);
    weekEnd.setHours(23, 59, 59, 999); // End of day
    
    // Check if today falls within or after this week's range (within reasonable time)
    // We consider a period/week valid for a fiscal year if:
    // 1. We're currently within that week, OR
    // 2. We're processing data for a past week in that fiscal year, OR
    // 3. We're processing data for an upcoming week in that fiscal year
    
    // Simple heuristic: if today is within 90 days of the week's dates, it's likely the right fiscal year
    const daysDiff = Math.abs((today - weekStart) / (1000 * 60 * 60 * 24));
    
    if (daysDiff < 180) {
      return fy;
    }
  }
  
  // Fallback: determine based on which fiscal year contains today
  for (const [fiscalYear, calendar] of Object.entries(FISCAL_CALENDARS)) {
    if (today >= calendar.startDate && today <= calendar.endDate) {
      return parseInt(fiscalYear, 10);
    }
  }
  
  // Default to current calendar year's fiscal year mapping
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth(); // 0-indexed
  
  // If we're in Jan, we're likely still in the previous fiscal year
  if (currentMonth === 0) {
    return currentYear - 1;
  }
  // If we're Feb-Dec, we're in the current fiscal year
  return currentYear;
}

/**
 * Get the fiscal year explicitly for the "next" week calculation
 * Used when P13W4 wraps to P01W1
 * 
 * @param {number|string} currentPeriod - Current period number
 * @param {number|string} currentWeek - Current week number  
 * @param {number|string} nextPeriod - Next period number
 * @param {number|string} nextWeek - Next week number
 * @returns {number} Fiscal year for the next period/week
 */
function getNextWeekFiscalYear(currentPeriod, currentWeek, nextPeriod, nextWeek) {
  const currPeriod = parseInt(currentPeriod, 10);
  const currWeek = parseInt(currentWeek, 10);
  const nxtPeriod = parseInt(nextPeriod, 10);
  
  // If we're going from P13 to P01, increment fiscal year
  if (currPeriod === 13 && nxtPeriod === 1) {
    const currentFiscalYear = getFiscalYear(currPeriod, currWeek);
    return currentFiscalYear + 1;
  }
  
  // Otherwise, same fiscal year
  return getFiscalYear(nxtPeriod, nextWeek);
}

/**
 * Calculate the next week from current period/week
 * 
 * @param {number|string} period - Current period (1-13)
 * @param {number|string} week - Current week (1-4)
 * @returns {Object} Next period/week info including fiscal year
 */
function calculateNextWeek(period, week) {
  const periodNum = parseInt(period, 10);
  const weekNum = parseInt(week, 10);
  
  let nextPeriod, nextWeek;
  
  if (weekNum < 4) {
    nextPeriod = periodNum;
    nextWeek = weekNum + 1;
  } else {
    // Week 4 wraps to next period's week 1
    nextPeriod = periodNum >= 13 ? 1 : periodNum + 1;
    nextWeek = 1;
  }
  
  const currentFiscalYear = getFiscalYear(periodNum, weekNum);
  const nextFiscalYear = getNextWeekFiscalYear(periodNum, weekNum, nextPeriod, nextWeek);
  
  return {
    period: nextPeriod,
    week: nextWeek,
    periodStr: String(nextPeriod).padStart(2, '0'),
    weekStr: String(nextWeek),
    fiscalYear: nextFiscalYear,
    currentFiscalYear: currentFiscalYear,
    isYearTransition: nextFiscalYear !== currentFiscalYear
  };
}

/**
 * Calculate the previous week from the current period/week.
 * Mirror of calculateNextWeek() but in reverse.
 *
 * @param {number|string} period - Current period (1-13)
 * @param {number|string} week - Current week (1-4)
 * @returns {Object} Previous period/week info including fiscal year
 */
function calculatePreviousWeek(period, week) {
  const periodNum = parseInt(period, 10);
  const weekNum = parseInt(week, 10);

  let prevPeriod, prevWeek;

  if (weekNum > 1) {
    prevPeriod = periodNum;
    prevWeek = weekNum - 1;
  } else {
    // Week 1 wraps to previous period's week 4
    prevPeriod = periodNum <= 1 ? 13 : periodNum - 1;
    prevWeek = 4;
  }

  const currentFiscalYear = getFiscalYear(periodNum, weekNum);
  // If we're going from P01W1 back to P13W4, the previous week is in the prior fiscal year
  const prevFiscalYear = (periodNum === 1 && prevPeriod === 13)
    ? currentFiscalYear - 1
    : getFiscalYear(prevPeriod, prevWeek);

  return {
    period: prevPeriod,
    week: prevWeek,
    periodStr: String(prevPeriod).padStart(2, '0'),
    weekStr: String(prevWeek),
    fiscalYear: prevFiscalYear,
    currentFiscalYear,
    isYearTransition: prevFiscalYear !== currentFiscalYear,
  };
}

/**
 * Get the full folder path for a period/week in a specific fiscal year
 * 
 * @param {number|string} period - Period number (1-13)
 * @param {number|string} week - Week number (1-4)
 * @param {number} fiscalYear - Fiscal year (2025, 2026, etc.)
 * @returns {Object} Folder info including paths
 */
function getFolderInfo(period, week, fiscalYear = null) {
  const periodStr = String(parseInt(period, 10)).padStart(2, '0');
  const weekStr = String(parseInt(week, 10));
  
  // Determine fiscal year if not provided
  const fy = fiscalYear || getFiscalYear(period, week);
  
  const calendar = FISCAL_CALENDARS[fy];
  if (!calendar) {
    throw new Error(`No fiscal calendar defined for year ${fy}`);
  }
  
  const periodData = calendar.periods[periodStr];
  if (!periodData) {
    throw new Error(`Period ${periodStr} not found in fiscal year ${fy}`);
  }
  
  const weekData = periodData.weeks[weekStr];
  if (!weekData) {
    throw new Error(`Week ${weekStr} not found in period ${periodStr} of fiscal year ${fy}`);
  }
  
  // Build the full path
  // Format: {DumpBinPath}/Kompass/{PeriodFolder}/{WeekFolder}
  const relativePath = path.join(
    calendar.dumpBinPath,
    'Kompass',
    periodData.name,
    weekData.folder
  );
  
  return {
    fiscalYear: fy,
    dumpBinPath: calendar.dumpBinPath,
    periodName: periodData.name,
    weekFolder: weekData.folder,
    relativePath: relativePath,
    startDate: weekData.start,
    endDate: weekData.end,
    periodWeek: `P${periodStr}W${weekStr}`
  };
}

/**
 * Get the dump bin base path for a fiscal year
 * 
 * @param {number} fiscalYear - Fiscal year
 * @returns {string} Dump bin folder name
 */
function getDumpBinPath(fiscalYear) {
  const calendar = FISCAL_CALENDARS[fiscalYear];
  if (!calendar) {
    throw new Error(`No fiscal calendar defined for year ${fiscalYear}`);
  }
  return calendar.dumpBinPath;
}

/**
 * Get the "A Useful Folder" URL for the current fiscal year
 * 
 * @param {number} fiscalYear - Fiscal year
 * @returns {string} SharePoint URL for the useful folder
 */
/** A Useful Folder base URL (rId7) */
const A_USEFUL_FOLDER_URL = 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder?csf=1&web=1&e=delGKf';

function getUsefulFolderUrl(fiscalYear) {
  return A_USEFUL_FOLDER_URL;
}

/**
 * Subfolders and vendor schedules under "A Useful Folder" with their display names and URLs.
 * Used by Considerations to inject clickable links for Vendor Sets and GM sections.
 * Ordered by name length (longest first) so "2026 Mapping and Fixture Files" matches before "Mapping and Fixture Files".
 * URLs from SharePoint link mappings (rId4–rId12).
 */
const USEFUL_FOLDER_SUBFOLDERS = [
  { name: '2026 Spring Cosmetics Reset', url: 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder/Vendor%20Schedules/2026%20Spring%20Cosmetics%20Reset?csf=1&web=1&e=SQ9RWp' },
  { name: '2026 Empire Meat Resets', url: 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder/Vendor%20Schedules/2026%20Empire%20Meat%20Resets?csf=1&web=1&e=T3xz5d' },
  { name: '2026 Spring Adult Beverage', url: 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder/Vendor%20Schedules/2026%20Spring%20Adult%20Beverage?csf=1&web=1&e=PwbprR' },
  { name: '2026 Mapping and Fixture Files', url: 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder/2026%20Mapping%20and%20Fixture%20Files?csf=1&web=1&e=e83DJp' },
  { name: 'Mapping and Fixture Files', url: 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder/2026%20Mapping%20and%20Fixture%20Files?csf=1&web=1&e=e83DJp' },
  { name: '2026 Strip Manifests', url: 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder/POG/2026%20Strip%20Manifests?csf=1&web=1&e=qhU9sX' },
  { name: 'Deli Layouts and Strip Orders', url: 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder/Deli%20Layouts%20and%20Strip%20Orders?csf=1&web=1&e=dUNCKe' },
  { name: 'Bakery Stand Up', url: 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder/Bakery%20Stand%20Up?csf=1&web=1&e=Ec3Rv2' },
  { name: 'GM Blitz Mapping', url: 'https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/2026%20Dump%20Bin/A%20Useful%20Folder/GM%20Blitz%20Mapping?csf=1&web=1&e=c0iq7o' },
];

/** URL for GM Blitz Mapping (used in GM Kompass section) */
const GM_BLITZ_MAPPING_URL = USEFUL_FOLDER_SUBFOLDERS.find(f => f.name === 'GM Blitz Mapping')?.url || '';

/**
 * Get subfolder link map for Considerations link injection.
 * Returns array of { name, url } ordered by name length (longest first) for correct replacement.
 */
function getUsefulSubfolderLinks(fiscalYear) {
  return [...USEFUL_FOLDER_SUBFOLDERS].sort((a, b) => b.name.length - a.name.length);
}

function getGmBlitzMappingUrl() {
  return GM_BLITZ_MAPPING_URL;
}

/**
 * Get the SharePoint URL for a specific week folder in the dump bin
 * 
 * @param {number|string} period - Period number (1-13)
 * @param {number|string} week - Week number (1-4)
 * @param {number} fiscalYear - Fiscal year (2025, 2026, etc.)
 * @returns {string} SharePoint URL for the week folder
 */
function getWeekFolderUrl(period, week, fiscalYear = null) {
  const info = getFolderInfo(period, week, fiscalYear);
  const segments = info.relativePath.split(path.sep).join('/');
  const encodedPath = segments.split('/').map(s => encodeURIComponent(s)).join('/');
  return `https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/${encodedPath}?csf=1&web=1&e=YCbxPx`;
}

/**
 * SharePoint URL for the per-week "P##W# Agenda" subfolder (raw images and other
 * non-PDF agenda attachments land here when they are not converted to PDF).
 *
 * @param {number|string} period
 * @param {number|string} week
 * @param {number|null} fiscalYear
 * @returns {string}
 */
function getAgendaAttachmentsFolderUrl(period, week, fiscalYear = null) {
  const info = getFolderInfo(period, week, fiscalYear);
  const segments = info.relativePath.split(path.sep).join('/');
  const encodedPath = segments.split('/').map(s => encodeURIComponent(s)).join('/');
  const agendaFolder = encodeURIComponent(`${info.periodWeek} Agenda`);
  return `https://advantagesolutionsnet-my.sharepoint.com/:f:/r/personal/tyson_gauthier_advantagesolutions_net/Documents/${encodedPath}/${agendaFolder}?csf=1&web=1&e=YCbxPx`;
}

/**
 * Direct SharePoint URL to an individual file that lives in the dump-bin
 * week folder. Used to generate inline hyperlinks to agenda attachments
 * (planograms, instruction decks, store-mapping PDFs, conference summaries, …)
 * instead of linking to a parent folder.
 *
 * @param {number|string} period
 * @param {number|string} week
 * @param {string} fileName - Basename of the file in the week folder, including extension.
 * @param {number|null} fiscalYear
 * @returns {string}
 */
function getDumpBinFileUrl(period, week, fileName, fiscalYear = null) {
  if (!fileName) return '';
  const info = getFolderInfo(period, week, fiscalYear);
  const segments = info.relativePath.split(path.sep).join('/');
  const encodedPath = segments.split('/').map(s => encodeURIComponent(s)).join('/');
  const encodedFile = encodeURIComponent(fileName);
  return `https://advantagesolutionsnet-my.sharepoint.com/personal/tyson_gauthier_advantagesolutions_net/Documents/${encodedPath}/${encodedFile}?web=1`;
}

/**
 * Direct SharePoint URL to a file inside the per-week `P##W# Agenda` subfolder
 * (raw images and other non-PDF artifacts that could not be converted).
 *
 * @param {number|string} period
 * @param {number|string} week
 * @param {string} fileName - Basename in the Agenda subfolder, including extension.
 * @param {number|null} fiscalYear
 * @returns {string}
 */
function getDumpBinAgendaFileUrl(period, week, fileName, fiscalYear = null) {
  if (!fileName) return '';
  const info = getFolderInfo(period, week, fiscalYear);
  const segments = info.relativePath.split(path.sep).join('/');
  const encodedPath = segments.split('/').map(s => encodeURIComponent(s)).join('/');
  const agendaFolder = encodeURIComponent(`${info.periodWeek} Agenda`);
  const encodedFile = encodeURIComponent(fileName);
  return `https://advantagesolutionsnet-my.sharepoint.com/personal/tyson_gauthier_advantagesolutions_net/Documents/${encodedPath}/${agendaFolder}/${encodedFile}?web=1`;
}

/**
 * Format period/week as string
 * 
 * @param {number|string} period - Period number
 * @param {number|string} week - Week number
 * @returns {string} Formatted string like "P01W1"
 */
function formatPeriodWeek(period, week) {
  return `P${String(period).padStart(2, '0')}W${week}`;
}

/**
 * Get the current period/week based on today's date
 * 
 * @returns {Object|null} Current period/week info or null if not found
 */
function getCurrentPeriodWeek() {
  const today = new Date();
  return getPeriodWeekForDate(today);
}

/**
 * Get the fiscal period/week for an arbitrary date
 * 
 * @param {Date} targetDate - The date to look up
 * @returns {Object|null} Period/week info or null if the date falls outside all defined calendars
 */
/**
 * Parse a `yyyy-mm-dd` date string as a LOCAL-time Date. The default
 * `new Date('yyyy-mm-dd')` parses as UTC midnight, which lands the date
 * on the previous calendar day in negative UTC offsets (and shifts forward
 * in positive offsets). Period/week boundaries are calendar dates, so we
 * must compare in local time.
 */
function parseLocalIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return new Date(s);
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

function getPeriodWeekForDate(targetDate) {
  const target = new Date(targetDate);
  target.setHours(12, 0, 0, 0); // Normalize to midday to avoid timezone edge cases

  for (const [fiscalYear, calendar] of Object.entries(FISCAL_CALENDARS)) {
    for (const [periodNum, periodData] of Object.entries(calendar.periods)) {
      for (const [weekNum, weekData] of Object.entries(periodData.weeks)) {
        const start = parseLocalIsoDate(weekData.start);
        start.setHours(0, 0, 0, 0);
        const end = parseLocalIsoDate(weekData.end);
        end.setHours(23, 59, 59, 999);

        if (target >= start && target <= end) {
          return {
            period: parseInt(periodNum, 10),
            week: parseInt(weekNum, 10),
            periodStr: periodNum,
            weekStr: weekNum,
            fiscalYear: parseInt(fiscalYear, 10),
            startDate: weekData.start,
            endDate: weekData.end,
            periodWeek: `P${periodNum}W${weekNum}`,
            periodName: periodData.name,
            weekFolder: weekData.folder
          };
        }
      }
    }
  }

  return null;
}

/**
 * Unpadded period/week format `P#W#`. Used for the InstaWork Sign Out
 * Sheets folder structure on OneDrive (e.g. `P2W3`, `P3W1`, `P10W4`).
 * The canonical zero-padded form (`P##W#`) is `formatPeriodWeek`.
 */
function formatPeriodWeekUnpadded(period, week) {
  return `P${parseInt(period, 10)}W${parseInt(week, 10)}`;
}

/**
 * Check if the fiscal calendar has data for a given year
 * 
 * @param {number} fiscalYear - Fiscal year to check
 * @returns {boolean} True if calendar exists
 */
function hasCalendar(fiscalYear) {
  return !!FISCAL_CALENDARS[fiscalYear];
}

/**
 * Get all available fiscal years
 * 
 * @returns {number[]} Array of fiscal years
 */
function getAvailableFiscalYears() {
  return Object.keys(FISCAL_CALENDARS).map(y => parseInt(y, 10)).sort();
}

module.exports = {
  FISCAL_CALENDARS,
  getFiscalYear,
  getNextWeekFiscalYear,
  calculateNextWeek,
  calculatePreviousWeek,
  getFolderInfo,
  getDumpBinPath,
  getUsefulFolderUrl,
  getUsefulSubfolderLinks,
  getGmBlitzMappingUrl,
  getWeekFolderUrl,
  getAgendaAttachmentsFolderUrl,
  getDumpBinFileUrl,
  getDumpBinAgendaFileUrl,
  formatPeriodWeek,
  formatPeriodWeekUnpadded,
  getCurrentPeriodWeek,
  getPeriodWeekForDate,
  hasCalendar,
  getAvailableFiscalYears
};
