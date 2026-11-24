import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme';
import { useSubscription } from '../store/SubscriptionContext';
import { Icon } from '../components/common/Icon';
import { FloatingGlassTabBar } from './components/FloatingGlassTabBar';

import { DealsScreen } from '../screens/deals/DealsScreen';
import { ShoppingListScreen } from '../screens/shopping/ShoppingListScreen';
import { CheffityScreen } from '../screens/cheffity/CheffityScreen';
import { WeeklyPlannerScreen } from '../screens/planner/WeeklyPlannerScreen';
import { ProfileScreen } from '../screens/profile/ProfileScreen';
import { SubscriptionScreen } from '../screens/profile/SubscriptionScreen';
import { PreferencesScreen } from '../screens/profile/PreferencesScreen';
import { DietTrackingScreen } from '../screens/profile/DietTrackingScreen';
import { TrendsScreen } from '../screens/profile/TrendsScreen';
import { FavoritesScreen } from '../screens/deals/FavoritesScreen';

// App-level stack wrapping the bottom tabs. The header tools (Einkauf & Lager,
// Profil) push these screens over the tab bar; see HeaderActions.
const RootStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
const ProfileStack = createNativeStackNavigator();

function ProfileStackNavigator() {
  return (
    <ProfileStack.Navigator screenOptions={{ headerShown: false }}>
      <ProfileStack.Screen name="ProfileMain">
        {(props) => (
          <ProfileScreen
            onClose={() => props.navigation.getParent()?.goBack()}
            onNavigateToPreferences={() => props.navigation.navigate('Preferences')}
            onNavigateToSubscription={() => props.navigation.navigate('Subscription')}
            onNavigateToTrends={() => props.navigation.navigate('Trends')}
            onNavigateToFavorites={() => props.navigation.navigate('Favorites')}
          />
        )}
      </ProfileStack.Screen>
      <ProfileStack.Screen name="Subscription">
        {(props) => <SubscriptionScreen onBack={() => props.navigation.goBack()} />}
      </ProfileStack.Screen>
      <ProfileStack.Screen name="Preferences">
        {(props) => <PreferencesScreen onBack={() => props.navigation.goBack()} />}
      </ProfileStack.Screen>
      <ProfileStack.Screen name="Trends">
        {(props) => <TrendsScreen onBack={() => props.navigation.goBack()} />}
      </ProfileStack.Screen>
      <ProfileStack.Screen name="Favorites">
        {(props) => <FavoritesScreen onBack={() => props.navigation.goBack()} />}
      </ProfileStack.Screen>
    </ProfileStack.Navigator>
  );
}

// The four main areas. Tools (shopping/pantry) and account (profile) are no
// longer tabs — they hang off the app stack via the header icons.
function BottomTabs() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { hasFeature } = useSubscription();

  return (
    <Tab.Navigator
      // Custom floating glass tab bar (see FloatingGlassTabBar). It reads each
      // screen's tabBarIcon/tabBarLabel below, so locked-feature colouring and
      // labels stay defined here.
      tabBar={(props) => <FloatingGlassTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.tabBarActive,
        tabBarInactiveTintColor: colors.tabBarInactive,
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tab.Screen
        name="Deals"
        component={DealsScreen}
        options={{
          tabBarLabel: t('tabs.deals'),
          tabBarIcon: ({ color, size, focused }) => (
            <Icon name="tag" color={color} size={size} active={focused} />
          ),
        }}
      />
      <Tab.Screen
        name="Cheffity"
        component={CheffityScreen}
        options={{
          tabBarLabel: t('tabs.cheffity'),
          tabBarIcon: ({ color, size, focused }) => (
            <Icon
              name="swipe"
              color={hasFeature('cheffity') ? color : colors.locked}
              size={size}
              active={focused && hasFeature('cheffity')}
            />
          ),
        }}
      />
      <Tab.Screen
        name="WeeklyPlanner"
        component={WeeklyPlannerScreen}
        options={{
          tabBarLabel: t('tabs.weeklyPlanner'),
          tabBarIcon: ({ color, size, focused }) => (
            <Icon
              name="plan"
              color={hasFeature('weekly_planner') ? color : colors.locked}
              size={size}
              active={focused && hasFeature('weekly_planner')}
            />
          ),
        }}
      />
      <Tab.Screen
        name="Tracking"
        options={{
          tabBarLabel: t('tabs.tracking'),
          tabBarIcon: ({ color, size, focused }) => (
            <Icon
              name="flame"
              color={hasFeature('diet_tracking') ? color : colors.locked}
              size={size}
              active={focused && hasFeature('diet_tracking')}
            />
          ),
        }}
      >
        {() => <DietTrackingScreen />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

export function MainTabNavigator() {
  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      <RootStack.Screen name="Tabs" component={BottomTabs} />
      <RootStack.Screen name="InventoryHub" component={ShoppingListScreen} />
      <RootStack.Screen name="Profile" component={ProfileStackNavigator} />
    </RootStack.Navigator>
  );
}
