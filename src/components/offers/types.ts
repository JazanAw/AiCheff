export interface OfferFiltersState {
  store: string;
  category: string;
  scope: 'all' | 'national' | 'local';
  search: string;
  selectedTags: string[];
  onlyFood: boolean;
  onlyCurrentWeek: boolean;
}
