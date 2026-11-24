import React, { createContext, useContext, useEffect, useState } from 'react';
import { SubscriptionTier } from '../types';
import { useAuth } from './AuthContext';
import { supabase } from '../config/supabase';

interface SubscriptionState {
  tier: SubscriptionTier;
  isLoading: boolean;
  hasFeature: (feature: Feature) => boolean;
  requiredTier: (feature: Feature) => SubscriptionTier;
}

type Feature =
  | 'no_ads'
  | 'nutrition'
  | 'price_history'
  | 'notifications'
  | 'compare_stores'
  | 'share_list'
  | 'cheffity'
  | 'weekly_planner'
  | 'full_nutrition'
  | 'cheapest_store'
  | 'unlimited_compare'
  | 'export_list'
  | 'early_access'
  | 'unlimited_cheffity'
  | 'diet_tracking';

const featureTiers: Record<Feature, SubscriptionTier> = {
  no_ads: 'plus',
  nutrition: 'plus',
  price_history: 'plus',
  notifications: 'plus',
  compare_stores: 'plus',
  share_list: 'plus',
  cheffity: 'plus',
  weekly_planner: 'plus',
  full_nutrition: 'premium',
  cheapest_store: 'premium',
  unlimited_compare: 'premium',
  export_list: 'premium',
  early_access: 'premium',
  unlimited_cheffity: 'premium',
  diet_tracking: 'premium',
};

const tierRank: Record<SubscriptionTier, number> = {
  free: 0,
  plus: 1,
  premium: 2,
};

const SubscriptionContext = createContext<SubscriptionState | null>(null);

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [tier, setTier] = useState<SubscriptionTier>('free');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setTier('free');
      setIsLoading(false);
      return;
    }

    async function fetchSubscription() {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('tier, status')
        .eq('user_id', user!.id)
        .eq('status', 'active')
        .single();

      if (!error && data) {
        setTier(data.tier as SubscriptionTier);
      } else {
        setTier('free');
      }
      setIsLoading(false);
    }

    fetchSubscription();

    const channel = supabase
      .channel('subscription-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'subscriptions',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const record = payload.new as { tier?: string; status?: string } | undefined;
          if (record?.status === 'active' && record?.tier) {
            setTier(record.tier as SubscriptionTier);
          } else {
            setTier('free');
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const hasFeature = (feature: Feature): boolean => {
    const required = featureTiers[feature];
    return tierRank[tier] >= tierRank[required];
  };

  const requiredTier = (feature: Feature): SubscriptionTier => {
    return featureTiers[feature];
  };

  return (
    <SubscriptionContext.Provider value={{ tier, isLoading, hasFeature, requiredTier }}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription(): SubscriptionState {
  const context = useContext(SubscriptionContext);
  if (!context) {
    throw new Error('useSubscription must be used within SubscriptionProvider');
  }
  return context;
}

export type { Feature };
