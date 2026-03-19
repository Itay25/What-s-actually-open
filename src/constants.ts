import { Place, Category } from './types';

export const CATEGORIES: Category[] = [
  { id: 'super', label: 'סופרים', icon: 'ShoppingCart' },
  { id: 'cafe', label: 'בתי קפה', icon: 'Coffee' },
  { id: 'restaurant', label: 'מסעדות', icon: 'Utensils' },
  { id: 'pharmacy', label: 'בתי מרקחת', icon: 'Pill' },
  { id: 'gas', label: 'תחנות דלק', icon: 'Fuel' },
  { id: 'bakery', label: 'מאפיות', icon: 'Croissant' },
  { id: 'atm', label: 'כספומטים', icon: 'CreditCard' },
  { id: 'attractions', label: 'אטרקציות', icon: 'Ticket' },
];

const now = Date.now();

export const MOCK_PLACES: Place[] = [
  {
    id: '1',
    name: 'קפה השכונה',
    lat: 32.0853,
    lng: 34.7818,
    peopleCount: 12,
    lastUpdate: 'לפני 2 דק׳',
    lastUpdateTimestamp: now - 2 * 60 * 1000,
    category: 'בתי קפה',
    confirmations: 8,
    officialOpen: true,
    openingHours: ["יום ראשון: 07:00 – 23:00", "יום שני: 07:00 – 23:00", "יום שלישי: 07:00 – 23:00", "יום רביעי: 07:00 – 23:00", "יום חמישי: 07:00 – 23:00", "יום שישי: 07:00 – 17:00", "יום שבת: 19:00 – 23:30"],
    socialPulse: 'active',
    physicalPresence: 0.8,
    popularTimes: [
      { day: 'Sunday', hours: [0, 0, 0, 0, 0, 0, 15, 40, 70, 85, 95, 90, 80, 75, 70, 75, 85, 95, 100, 90, 70, 40, 15, 0] },
      { day: 'Monday', hours: [0, 0, 0, 0, 0, 0, 10, 35, 65, 80, 90, 85, 75, 65, 60, 65, 80, 95, 100, 85, 65, 35, 10, 0] },
      { day: 'Tuesday', hours: [0, 0, 0, 0, 0, 0, 10, 35, 65, 80, 90, 85, 75, 65, 60, 65, 80, 95, 100, 85, 65, 35, 10, 0] },
      { day: 'Wednesday', hours: [0, 0, 0, 0, 0, 0, 10, 35, 65, 80, 90, 85, 75, 65, 60, 65, 80, 95, 100, 85, 65, 35, 10, 0] },
      { day: 'Thursday', hours: [0, 0, 0, 0, 0, 0, 10, 35, 65, 80, 90, 85, 75, 65, 60, 65, 80, 95, 100, 85, 65, 35, 10, 0] },
      { day: 'Friday', hours: [0, 0, 0, 0, 0, 0, 15, 45, 75, 90, 100, 95, 85, 75, 70, 75, 85, 90, 80, 60, 40, 20, 5, 0] },
      { day: 'Saturday', hours: [0, 0, 0, 0, 0, 0, 5, 20, 40, 60, 80, 95, 100, 95, 85, 80, 85, 95, 100, 90, 70, 40, 15, 0] }
    ]
  },
  {
    id: '2',
    name: 'פיצה דה לוקס',
    lat: 32.0880,
    lng: 34.7850,
    peopleCount: 3,
    lastUpdate: 'לפני 15 דק׳',
    lastUpdateTimestamp: now - 15 * 60 * 1000,
    category: 'מסעדות',
    confirmations: 2,
    officialOpen: true,
    openingHours: ["יום ראשון: 12:00 – 00:00", "יום שני: 12:00 – 00:00", "יום שלישי: 12:00 – 00:00", "יום רביעי: 12:00 – 00:00", "יום חמישי: 12:00 – 01:00", "יום שישי: 12:00 – 16:00", "יום שבת: 19:00 – 01:00"],
    socialPulse: 'inactive',
    physicalPresence: 0.2
  },
  {
    id: '3',
    name: 'פאב העיר',
    lat: 32.0820,
    lng: 34.7780,
    peopleCount: 0,
    lastUpdate: 'לפני שעה',
    lastUpdateTimestamp: now - 60 * 60 * 1000,
    category: 'בתי קפה',
    confirmations: 0,
    officialOpen: false,
    openingHours: ["יום ראשון: 20:00 – 03:00", "יום שני: 20:00 – 03:00", "יום שלישי: 20:00 – 03:00", "יום רביעי: 20:00 – 03:00", "יום חמישי: 20:00 – 04:00", "יום שישי: סגור", "יום שבת: 21:00 – 04:00"],
    socialPulse: 'closed_signal',
    physicalPresence: 0
  },
  {
    id: '4',
    name: 'סופר יודה',
    lat: 32.0840,
    lng: 34.7880,
    peopleCount: 24,
    lastUpdate: 'ממש עכשיו',
    lastUpdateTimestamp: now,
    category: 'סופרים',
    confirmations: 15,
    officialOpen: true,
    openingHours: ["יום ראשון: פתוח 24 שעות", "יום שני: פתוח 24 שעות", "יום שלישי: פתוח 24 שעות", "יום רביעי: פתוח 24 שעות", "יום חמישי: פתוח 24 שעות", "יום שישי: פתוח 24 שעות", "יום שבת: פתוח 24 שעות"],
    socialPulse: 'active',
    physicalPresence: 0.9
  }
];
