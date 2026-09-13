import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert,
  Platform, Image, StatusBar, Dimensions, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../navigation/types';
import { colors } from '../../theme/colors';
import { ActiveRequest, useApp } from '../../context/AppContext';
import { db } from '../../lib/database';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { UserSafetySheet, SafetyTarget } from '../../components/UserSafetySheet';
import { fmtAmt } from '../../lib/utils';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Parses activity text into a social-feed style sentence

// ─── Component ────────────────────────────────────────────────────────────────

function describeAmountError(msg: string): string {
  if (msg.includes('amount_below_minimum')) return 'Amount must be at least £0.50.';
  if (msg.includes('amount_precision_invalid')) return 'Please enter a whole number or up to 2 decimal places (e.g. £5.50).';
  if (msg.includes('invalid_amount')) return 'Please enter a valid amount.';
  return msg;
}

export const CircleScreen: React.FC = () => {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {
    activeRequests, setActiveRequests, circle, setCircle,
    child, childId, setChild, addTransaction, addActivity, removeActivity,
    pendingRequests, setPendingRequests, recordWeeklyStreak, frozenAccount,
    repayHighlightId, setRepayHighlightId,
    childSessionToken, childDeviceId, handleSessionError,
  } = useApp();

  const [fundingRequest,  setFundingRequest]  = useState<ActiveRequest | null>(null);
  const [repayingRequest, setRepayingRequest] = useState<ActiveRequest | null>(null);
  const [selectedFriend, setSelectedFriend] = useState<{
    id: string; displayName: string; username: string;
    avatarEmoji: string; profileImageUrl?: string; trustScore: number;
  } | null>(null);
  const [safetyTarget, setSafetyTarget] = useState<SafetyTarget | null>(null);
  const [showHistory,       setShowHistory]       = useState(false);
  const [showAllFriendReqs, setShowAllFriendReqs] = useState(false);
  const [reqTab,          setReqTab]          = useState<'toFund' | 'pending'>('toFund');
  const [showAllToFund,   setShowAllToFund]   = useState(false);
  const [loanHistory, setLoanHistory] = useState<Array<{
    id: string; amount: number; reason: string; reasonEmoji: string;
    createdAt: string; repaidAt: string | null; repayByDate: string;
    status: string; isBorrower: boolean; repaidOnTime: boolean;
    borrowerName: string; borrowerUsername: string; borrowerEmoji: string; borrowerAvatarUrl: string | null;
    funderName: string; funderUsername: string; funderEmoji: string; funderAvatarUrl: string | null;
  }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [highlightedId,  setHighlightedId]  = useState<string | null>(null);

  const scrollRef      = useRef<import('react-native').ScrollView>(null);
  const requestsCardY  = useRef(0);

  useFocusEffect(
    useCallback(() => {
      if (repayHighlightId) {
        setRepayHighlightId(null);
        setReqTab('pending');
        setHighlightedId(repayHighlightId);
      }
    }, [repayHighlightId])
  );

  useEffect(() => {
    if (!highlightedId) return;
    const scrollTimer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: Math.max(0, requestsCardY.current - 16), animated: true });
    }, 300);
    const clearTimer = setTimeout(() => setHighlightedId(null), 3500);
    return () => { clearTimeout(scrollTimer); clearTimeout(clearTimer); };
  }, [highlightedId]);

  const loadHistory = useCallback(async () => {
    if (!childId || historyLoading || !childSessionToken || !childDeviceId) return;
    setHistoryLoading(true);
    try {
      const rows = await db.getLoanHistory(childId, childSessionToken, childDeviceId);
      setLoanHistory(rows.map(r => ({
        id: r.id, amount: r.amount, reason: r.reason, reasonEmoji: r.reason_emoji,
        createdAt: r.created_at, repaidAt: r.repaid_at, repayByDate: r.repay_by_date,
        status: (r as any).status ?? 'repaid',
        isBorrower: r.is_borrower, repaidOnTime: r.repaid_on_time,
        borrowerName: r.borrower_name, borrowerUsername: r.borrower_username,
        borrowerEmoji: r.borrower_emoji, borrowerAvatarUrl: r.borrower_avatar_url,
        funderName: r.funder_name, funderUsername: r.funder_username,
        funderEmoji: r.funder_emoji, funderAvatarUrl: r.funder_avatar_url,
      })));
    } catch { /* best-effort */ } finally { setHistoryLoading(false); }
  }, [childId]);

  useEffect(() => { if (showHistory) loadHistory(); }, [showHistory]);

  // ── Friend request actions ─────────────────────────────────────────────────

  const handleAcceptRequest = async (requestId: string) => {
    if (!childId || !childSessionToken || !childDeviceId) return;
    try {
      await db.acceptCircleRequest(requestId, childId, childSessionToken, childDeviceId);
      const accepted = pendingRequests.find(r => r.requestId === requestId);
      setPendingRequests(prev => prev.filter(r => r.requestId !== requestId));
      if (accepted) {
        setCircle(prev => [...prev, {
          id: accepted.id, displayName: accepted.displayName,
          username: accepted.username, avatarEmoji: accepted.avatarEmoji,
          trustScore: accepted.trustScore, profileImageUrl: accepted.profileImageUrl,
        }]);
        addActivity({
          id: `a_friend_${Date.now()}`, emoji: '🤝',
          text: `${accepted.displayName.split(' ')[0]} joined your circle`,
          time: 'Just now', type: 'joined',
        });
        // Notification to requester delivered server-side via Edge Function
      }
    } catch (e: any) { Alert.alert('Error', e.message ?? 'Could not accept request.'); }
  };

  const handleDeclineRequest = async (requestId: string) => {
    if (!childId || !childSessionToken || !childDeviceId) return;
    try {
      const declined = pendingRequests.find(r => r.requestId === requestId);
      await db.declineCircleRequest(requestId, childId, childSessionToken, childDeviceId);
      setPendingRequests(prev => prev.filter(r => r.requestId !== requestId));
      if (declined) {
        addActivity({
          id: `a_decline_${Date.now()}`, emoji: '❌',
          text: `You declined ${declined.displayName.split(' ')[0]}'s request`,
          time: 'Just now', type: 'request',
        });
        // Notification to requester delivered server-side via Edge Function
      }
    } catch (e: any) { Alert.alert('Error', e.message ?? 'Could not decline request.'); }
  };

  const handleRemoveFriend = (memberId: string, username: string) => {
    if (!childId) return;

    // Client-side block: active funded loan in either direction
    const activeLoan = activeRequests.find(r =>
      r.isFunded === true &&
      ((r.fromId === childId && r.fundedById === memberId) ||
       (r.fromId === memberId && r.fundedById === childId))
    );
    if (activeLoan) {
      const msg = "You can't remove this person while money is still owed. Complete or resolve all active loans first.";
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Outstanding money', msg);
      return;
    }

    const doRemove = async () => {
      if (!childSessionToken || !childDeviceId) return;
      setSelectedFriend(null);
      try {
        await db.removeFromCircle(childId, memberId, childSessionToken, childDeviceId);

        // Remove from local circle immediately
        setCircle(prev => prev.filter(m => m.id !== memberId));

        // Remove their unfunded requests from the active list (viewer access revoked DB-side)
        setActiveRequests(prev => prev.filter(r => !(r.fromId === memberId && !r.isFunded)));

        addActivity({
          id: `a_remove_${Date.now()}`, emoji: '👋',
          text: `You removed @${username} from your circle`,
          time: 'Just now', type: 'request',
        });

        // Refresh circle from DB to reflect server state on both users' devices
        if (childId) {
          if (childSessionToken && childDeviceId) db.getCircle(childId, childSessionToken, childDeviceId).then(members => {
            setCircle(members.map(m => ({
              id: m.id, displayName: m.display_name, username: m.username,
              avatarEmoji: m.avatar_emoji, trustScore: m.trust_score,
              profileImageUrl: m.avatar_url ?? undefined,
            })));
          }).catch(() => {});
        }

        const successMsg = `@${username} has been removed from your Circle.`;
        Platform.OS === 'web'
          ? window.alert(successMsg)
          : Alert.alert('Removed', successMsg);
      } catch (e: any) {
        const msg = e.message ?? 'Could not remove friend.';
        const isLoanBlock = msg.includes('active_loan');
        const errMsg = isLoanBlock
          ? "You can't remove this person while money is still owed. Complete or resolve all active loans first."
          : msg;
        Platform.OS === 'web'
          ? window.alert(errMsg)
          : Alert.alert(isLoanBlock ? 'Outstanding money' : 'Error', errMsg);
      }
    };

    const title    = `Remove @${username} from your Circle?`;
    const message  = "You will no longer see each other's new requests or Circle updates. Previous loan and transaction history will remain.";
    if (Platform.OS === 'web') {
      if (window.confirm(`${title}\n\n${message}`)) doRemove();
    } else {
      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: doRemove },
      ]);
    }
  };

  // ── Fund / Repay ───────────────────────────────────────────────────────────

  const handleFund = (req: ActiveRequest) => {
    if (frozenAccount) {
      Alert.alert('Account frozen', 'Your account is frozen. Repay your parent to unlock lending.');
      return;
    }
    if (child.balance < req.amount) {
      Alert.alert('Insufficient balance', "You don't have enough balance to fund this request.");
      return;
    }
    setFundingRequest(req);
  };

  const confirmFund = async () => {
    if (!fundingRequest || !childId) return;
    if (!childSessionToken || !childDeviceId) { handleSessionError('invalid_child_session'); return; }
    const req = fundingRequest;
    setFundingRequest(null);
    try {
      const { borrowerPushToken } = await db.fundMoneyRequest(req.id, childId, req.amount, childSessionToken, childDeviceId);
      recordWeeklyStreak().catch(() => {});
      setActiveRequests(prev => prev.map(r =>
        r.id === req.id ? { ...r, isFunded: true, fundedById: childId, fundedByName: child.displayName, fundedByEmoji: child.avatarEmoji } : r
      ));
      setChild(c => ({
        ...c,
        balance:    c.balance    - req.amount,
        loanedOut:  c.loanedOut  + req.amount,
        totalLent:  c.totalLent  + req.amount,
        timesLent:  c.timesLent  + 1,
        trustScore: Math.min(100, c.trustScore + 2),
        points:     c.points     + 2,
      }));
      const borrowerName = circle.find(m => m.id === req.fromId)?.displayName ?? req.fromName;
      addActivity({ id: `fund_${req.id}`, emoji: '💚', text: `£${fmtAmt(req.amount)} lent to ${borrowerName}`, time: 'Just now', type: 'funded' });
      addTransaction({ id: `t_fund_${Date.now()}`, type: 'lend', amount: -req.amount, description: `£${fmtAmt(req.amount)} lent to ${borrowerName}`, date: 'Just now', counterparty: req.fromName, status: 'active' });
      // Notification to borrower delivered server-side via Edge Function
    } catch (e: any) {
      const msg: string = e.message ?? '';
      if (msg.includes('invalid_child_session') || msg.includes('child_session_expired') || msg.includes('child_session_revoked')) {
        handleSessionError(msg);
      } else { Alert.alert('Error', describeAmountError(msg) || 'Could not fund request.'); }
    }
  };

  const handleRepay = (req: ActiveRequest) => {
    if (child.balance < req.amount) {
      Platform.OS === 'web' ? window.alert("You don't have enough balance to repay.") : Alert.alert('Insufficient balance', "You don't have enough balance to repay.");
      return;
    }
    setRepayingRequest(req);
  };

  const confirmRepay = async () => {
    if (!repayingRequest || !childId) return;
    if (!childSessionToken || !childDeviceId) { handleSessionError('invalid_child_session'); return; }
    const req = repayingRequest;
    setRepayingRequest(null);
    try {
      const { amount: paidAmount } = await db.repayMoneyRequest(req.id, childId, childSessionToken, childDeviceId);
      const amt = paidAmount ?? req.amount;
      setActiveRequests(prev => prev.filter(r => r.id !== req.id));
      setChild(c => ({ ...c, balance: c.balance - amt, borrowed: Math.max(0, c.borrowed - amt), trustScore: Math.min(100, c.trustScore + 5), points: c.points + 5, repaid: c.repaid + 1 }));
      const funderName = circle.find(m => m.id === req.fundedById)?.displayName ?? req.fundedByName ?? 'friend';
      addActivity({ id: `repay_${req.id}`, emoji: '✅', text: `You repaid £${fmtAmt(amt)} to ${funderName}`, time: 'Just now', type: 'repaid' });
      addTransaction({ id: `t_repay_${Date.now()}`, type: 'repay', amount: -amt, description: `Repaid £${fmtAmt(amt)} to ${funderName}`, date: 'Just now', counterparty: req.fundedByName, status: 'completed' });
      // Notification to funder delivered server-side via Edge Function
    } catch (e: any) {
      const msg: string = e.message ?? '';
      if (msg.includes('invalid_child_session') || msg.includes('child_session_expired') || msg.includes('child_session_revoked')) {
        handleSessionError(msg);
      } else { Alert.alert('Error', msg || 'Could not repay.'); }
    }
  };

  // ── Derived data ───────────────────────────────────────────────────────────

  const friendRequests = activeRequests.filter(r => !r.isOwn && !r.isFunded);
  const ownFundedLoans = activeRequests.filter(r => r.isOwn  && r.isFunded);
  const ownPending     = activeRequests.filter(r => r.isOwn  && !r.isFunded);
  const fundedByMe     = activeRequests.filter(r => !r.isOwn && r.isFunded);

  const TO_FUND_LIMIT = 3;
  const visibleFriendRequests = showAllToFund ? friendRequests : friendRequests.slice(0, TO_FUND_LIMIT);
  const firstNameOf = (full: string) => full.split(' ')[0];

  // "Pending" tab: everything active for the current user
  const pendingItems = [...ownPending, ...ownFundedLoans, ...fundedByMe];

  const totalBadge = pendingRequests.length + activeRequests.filter(r => !r.isOwn).length;

  // Leaderboard: child + circle members, sorted by trust score desc, stable secondary sort by id
  const leaderboard = [
    { id: 'me', name: child.displayName, username: child.username, photo: child.profileImageUrl, emoji: child.avatarEmoji, score: child.trustScore, isYou: true },
    ...circle.map(m => ({ id: m.id, name: m.displayName, username: m.username, photo: m.profileImageUrl, emoji: m.avatarEmoji, score: m.trustScore, isYou: false })),
  ].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
   .map((m, i) => ({ ...m, rank: i + 1 }));

  const top4 = leaderboard.slice(0, 4);
  // Visual order: rank-2 | rank-1 (elevated, gold) | rank-3 | rank-4
  const ldrDisplay = top4.length >= 2 ? [top4[1], top4[0], ...top4.slice(2)] : top4;


  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <StatusBar barStyle="dark-content" />

      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false} contentContainerStyle={s.scroll}>

        {/* ── PAGE HEADER ─────────────────────────────────────────── */}
        <View style={s.pageHeader}>
          <View>
            <Text style={s.pageTitle}>Your Circle</Text>
            <Text style={s.pageSubtitle}>People you trust, earn more together.</Text>
          </View>
        </View>

        {/* ── FRIENDS ROW ─────────────────────────────────────────── */}
        {/*
          Layout: a fixed outer row containing:
          - A ScrollView exactly 4 slots wide (friends scroll through it)
          - A fixed 5th slot (Add Friend) that never scrolls away
        */}
        <View style={s.friendsOuter}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.friendsScroll}
            snapToInterval={SLOT_W}
            snapToAlignment="start"
            decelerationRate="fast"
            style={{ width: SLOT_W * 4 }}
          >
            {circle.map(m => (
              <TouchableOpacity
                key={m.id}
                style={s.friendSlot}
                activeOpacity={0.75}
                onPress={() => setSelectedFriend(m)}
              >
                {/* Outer wrapper sits outside overflow:hidden so the dot isn't clipped */}
                <View style={s.friendAvatarOuter}>
                  <View style={s.friendRingWrap}>
                    {m.profileImageUrl ? (
                      <Image source={{ uri: m.profileImageUrl }} style={s.friendPhoto} resizeMode="cover" />
                    ) : (
                      <View style={s.friendEmojiFill}>
                        <Text style={{ fontSize: 24 }}>{m.avatarEmoji}</Text>
                      </View>
                    )}
                  </View>
                  <View style={s.onlineDot} />
                </View>
                <Text style={s.friendUsername} numberOfLines={1}>@{m.username}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Fixed 5th slot — always visible, never scrolls */}
          <TouchableOpacity
            style={s.friendSlot}
            onPress={() => navigation.navigate('AddFriends')}
            activeOpacity={0.75}
          >
            <View style={s.addRingWrap}>
              <Ionicons name="add" size={26} color="#2E7D32" />
            </View>
            <Text style={s.addLabel}>Add</Text>
          </TouchableOpacity>
        </View>

        {/* ── PENDING FRIEND REQUESTS ─────────────────────────────── */}
        {pendingRequests.length > 0 && (
          <View style={s.cardOuter}>
            <View style={s.cardInner}>

              {/* Compact header */}
              <View style={s.frHeader}>
                <Ionicons name="person-add-outline" size={14} color="#2E7D32" />
                <Text style={s.frHeaderTitle}>Friend Requests</Text>
                <View style={s.countBadge}>
                  <Text style={s.countBadgeText}>{pendingRequests.length}</Text>
                </View>
              </View>

              {/* Request rows — first only, or all if expanded */}
              {(showAllFriendReqs ? pendingRequests : pendingRequests.slice(0, 1)).map((req, idx, arr) => (
                <View key={req.requestId} style={[s.frReqRow, idx < arr.length - 1 && s.rowDivider]}>
                  <View style={s.frReqAvatar}>
                    {req.profileImageUrl
                      ? <Image source={{ uri: req.profileImageUrl }} style={s.frReqAvatarImg} resizeMode="cover" />
                      : <Text style={{ fontSize: 18 }}>{req.avatarEmoji}</Text>}
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.frReqName} numberOfLines={1}>{req.displayName}</Text>
                    <Text style={s.frReqSub} numberOfLines={1}>@{req.username} · {req.trustScore} pts</Text>
                  </View>
                  <View style={s.frActions}>
                    <TouchableOpacity style={s.acceptBtn} onPress={() => handleAcceptRequest(req.requestId)} activeOpacity={0.85}>
                      <Text style={s.acceptText}>Accept</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={s.declineBtn}
                      onPress={() => handleDeclineRequest(req.requestId)}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="close" size={16} color="#6B7280" />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}

              {/* View more / collapse toggle */}
              {pendingRequests.length > 1 && (
                <TouchableOpacity
                  style={s.frViewAll}
                  onPress={() => setShowAllFriendReqs(v => !v)}
                  activeOpacity={0.7}
                >
                  <Text style={s.frViewAllText}>
                    {showAllFriendReqs ? 'Show less' : `View ${pendingRequests.length - 1} more`}
                  </Text>
                  <Ionicons
                    name={showAllFriendReqs ? 'chevron-up' : 'chevron-down'}
                    size={13}
                    color="#6B7280"
                  />
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* ── REQUESTS CARD ───────────────────────────────────────── */}
        <View style={s.cardOuter} onLayout={e => { requestsCardY.current = e.nativeEvent.layout.y; }}>
          <View style={s.cardInner}>

            {/* Title row */}
            <View style={s.reqCardHeader}>
              <Text style={s.cardTitle}>Requests</Text>
            </View>

            {/* Tab bar: To fund / Pending */}
            <View style={s.reqTabsWrap}>
              <TouchableOpacity style={s.reqTab} onPress={() => setReqTab('toFund')} activeOpacity={0.7}>
                <Text style={[s.reqTabText, reqTab === 'toFund' && s.reqTabTextActive]}>To fund</Text>
                {reqTab === 'toFund' && <View style={s.reqTabIndicator} />}
              </TouchableOpacity>
              <TouchableOpacity style={s.reqTab} onPress={() => setReqTab('pending')} activeOpacity={0.7}>
                <Text style={[s.reqTabText, reqTab === 'pending' && s.reqTabTextActive]}>Pending</Text>
                {reqTab === 'pending' && <View style={s.reqTabIndicator} />}
              </TouchableOpacity>
            </View>

            {/* ── TO FUND tab ──────────────────────────────────────── */}
            {reqTab === 'toFund' && (
              friendRequests.length === 0 ? (
                <View style={s.emptyRequests}>
                  <Text style={s.emptyEmoji}>💸</Text>
                  <Text style={s.emptyTitle}>Nothing to fund yet</Text>
                  <Text style={s.emptySub}>When friends in your circle request money, they'll appear here.</Text>
                </View>
              ) : (
                <>
                  {visibleFriendRequests.map((req, idx) => {
                    const member = circle.find(m => m.id === req.fromId);
                    return (
                      <View key={req.id} style={[s.requestRow, idx < visibleFriendRequests.length - 1 && s.rowDivider]}>
                        <View style={s.reqAvatar}>
                          {member?.profileImageUrl
                            ? <Image source={{ uri: member.profileImageUrl }} style={s.reqAvatarImg} resizeMode="cover" />
                            : <Text style={{ fontSize: 22 }}>{req.fromEmoji}</Text>}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={s.reqName}>{firstNameOf(req.fromName)}</Text>
                          <Text style={s.reqAmount}>needs £{fmtAmt(req.amount)}</Text>
                          <Text style={s.reqSub}>{req.reasonEmoji} {req.reason}</Text>
                        </View>
                        <View style={s.reqRight}>
                          <View style={s.reqTimeCol}>
                            <Text style={s.reqTime}>{req.expiresIn}h left</Text>
                            <Text style={s.reqDue}>Due {req.repayByDate}</Text>
                          </View>
                          <TouchableOpacity style={s.fundBtn} onPress={() => handleFund(req)} activeOpacity={0.85}>
                            <Text style={s.fundBtnText}>Fund</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}
                  {friendRequests.length > TO_FUND_LIMIT && (
                    <TouchableOpacity
                      style={s.viewAllToFund}
                      onPress={() => setShowAllToFund(v => !v)}
                      activeOpacity={0.7}
                    >
                      <Text style={s.viewAllToFundText}>
                        {showAllToFund
                          ? 'Show less'
                          : `View all ${friendRequests.length} requests`}
                      </Text>
                      <Ionicons
                        name={showAllToFund ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color="#2E7D32"
                      />
                    </TouchableOpacity>
                  )}
                </>
              )
            )}

            {/* ── PENDING tab ──────────────────────────────────────── */}
            {reqTab === 'pending' && (
              pendingItems.length === 0 ? (
                <>
                  <View style={s.emptyRequests}>
                    <Text style={s.emptyEmoji}>✅</Text>
                    <Text style={s.emptyTitle}>All clear</Text>
                    <Text style={s.emptySub}>No pending requests or outstanding loans right now.</Text>
                  </View>
                  {highlightedId && (
                    <View style={s.staleLoanNote}>
                      <Text style={s.staleLoanText}>This repayment is no longer outstanding.</Text>
                    </View>
                  )}
                </>
              ) : (
                pendingItems.map((req, idx) => {
                  const isOwnPending = req.isOwn && !req.isFunded;
                  const isOwnFunded  = req.isOwn && req.isFunded;
                  const isFundedByMe = !req.isOwn && req.isFunded;
                  const member       = circle.find(m => m.id === req.fromId);
                  const isHighlighted = req.id === highlightedId;

                  return (
                    <View key={req.id} style={[s.requestRow, idx < pendingItems.length - 1 && s.rowDivider, isHighlighted && s.requestRowHighlight]}>
                      {/* Avatar */}
                      <View style={s.reqAvatar}>
                        {isOwnPending ? (
                          child.profileImageUrl
                            ? <Image source={{ uri: child.profileImageUrl }} style={s.reqAvatarImg} resizeMode="cover" />
                            : <Text style={{ fontSize: 22 }}>{child.avatarEmoji}</Text>
                        ) : isOwnFunded ? (
                          <Text style={{ fontSize: 22 }}>{req.fundedByEmoji ?? '💚'}</Text>
                        ) : member?.profileImageUrl ? (
                          <Image source={{ uri: member.profileImageUrl }} style={s.reqAvatarImg} resizeMode="cover" />
                        ) : (
                          <Text style={{ fontSize: 22 }}>{req.fromEmoji}</Text>
                        )}
                      </View>

                      {/* Text — one summary line + reason; wraps instead of truncating so the full message is always visible */}
                      <View style={{ flex: 1 }}>
                        {isOwnPending && (
                          <>
                            <Text style={s.reqName}>You requested £{fmtAmt(req.amount)}</Text>
                            <Text style={s.reqSub}>{req.reasonEmoji} {req.reason}</Text>
                          </>
                        )}
                        {isOwnFunded && (
                          <>
                            <Text style={s.reqName}>{req.fundedByName ?? 'Friend'} lent you £{fmtAmt(req.amount)}</Text>
                            <Text style={s.reqSub}>{req.reasonEmoji} {req.reason}</Text>
                          </>
                        )}
                        {isFundedByMe && (
                          <>
                            <Text style={s.reqName}>{req.fromName} owes you £{fmtAmt(req.amount)}</Text>
                            <Text style={s.reqSub}>{req.reasonEmoji} {req.reason}</Text>
                          </>
                        )}
                      </View>

                      {/* Right column */}
                      <View style={s.reqRight}>
                        {isOwnPending && (
                          <>
                            <View style={s.reqTimeCol}>
                              <Text style={s.reqTime}>{req.expiresIn}h left</Text>
                              <Text style={s.reqDue}>Due {req.repayByDate}</Text>
                            </View>
                            <TouchableOpacity
                              style={s.cancelPill}
                              onPress={() => {
                                // Optimistic: remove from local state immediately.
                                // cancelMoneyRequest atomically updates status + deletes
                                // activity rows (a_req_* and moneyreq_*) in one transaction.
                                setActiveRequests(prev => prev.filter(r => r.id !== req.id));
                                removeActivity(`a_req_${req.id}`);
                                if (childId && childSessionToken && childDeviceId) {
                                  db.cancelMoneyRequest(req.id, childId, childSessionToken, childDeviceId).catch(() => {});
                                }
                              }}
                              activeOpacity={0.8}
                            >
                              <Text style={s.cancelPillText}>Cancel</Text>
                            </TouchableOpacity>
                          </>
                        )}
                        {isOwnFunded && (
                          <>
                            <View style={s.reqTimeCol}>
                              <Text style={s.reqDue}>Due {req.repayByDate}</Text>
                            </View>
                            <TouchableOpacity style={s.repayPill} onPress={() => handleRepay(req)} activeOpacity={0.85}>
                              <Text style={s.repayPillText}>Repay</Text>
                            </TouchableOpacity>
                          </>
                        )}
                        {isFundedByMe && (
                          <>
                            <View style={s.reqTimeCol}>
                              <Text style={s.reqDue}>Due {req.repayByDate}</Text>
                            </View>
                            <View style={s.awaitPill}>
                              <Text style={s.awaitText}>Waiting</Text>
                            </View>
                          </>
                        )}
                      </View>
                    </View>
                  );
                })
              )
            )}

          </View>
        </View>

        {/* ── CIRCLE LEADERBOARD (purple hero card) ───────────────── */}
        <LinearGradient
          colors={['#93C999', '#C8E8CB'] as const}
          style={s.ldrCard}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        >
          {/* Card header */}
          <View style={s.ldrHeader}>
            <Text style={s.ldrTrophy}>🏆</Text>
            <Text style={s.ldrTitle}>Circle Leaderboard</Text>
          </View>

          {/* Columns: visual order rank-2 | rank-1 (gold) | rank-3 | rank-4 */}
          <View style={s.ldrColumns}>
            {ldrDisplay.length === 0 ? (
              <Text style={s.ldrEmpty}>Add friends to see the leaderboard</Text>
            ) : (
              ldrDisplay.map((member, visIdx) => {
                const isFirst = member.rank === 1;
                return (
                  <React.Fragment key={member.id}>
                    {visIdx > 0 && <View style={s.ldrDivider} />}
                    <View style={s.ldrCol}>
                      {/* Rank badge */}
                      {isFirst ? (
                        <View style={s.goldBadge}>
                          <Text style={s.goldBadgeText}>1</Text>
                        </View>
                      ) : (
                        <Text style={s.ldrRankNum}>{member.rank}</Text>
                      )}

                      {/* Avatar */}
                      <View style={[s.ldrAvatarWrap, isFirst && s.ldrAvatarWrap1]}>
                        {member.photo ? (
                          <Image
                            source={{ uri: member.photo }}
                            style={isFirst ? s.ldrAvatarImg1 : s.ldrAvatarImg}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={[s.ldrAvatarFallback, isFirst && s.ldrAvatarFallback1]}>
                            <Text style={{ fontSize: isFirst ? 28 : 22 }}>{member.emoji}</Text>
                          </View>
                        )}
                      </View>

                      {/* Name */}
                      <Text style={[s.ldrName, member.isYou && s.ldrNameYou, isFirst && s.ldrNameFirst]} numberOfLines={1}>
                        {member.isYou ? 'You' : firstNameOf(member.name)}
                      </Text>
                      {/* Points */}
                      <Text style={[s.ldrPts, isFirst && s.ldrPtsFirst]}>{member.score} pts</Text>
                    </View>
                  </React.Fragment>
                );
              })
            )}
          </View>

          {/* View Full Leaderboard button */}
          <TouchableOpacity
            style={s.fullLdrBtn}
            onPress={() => navigation.navigate('Leaderboard')}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="View Full Leaderboard"
          >
            <Text style={s.fullLdrText}>View Full Leaderboard</Text>
            <Ionicons name="chevron-forward" size={18} color="#FFFFFF" />
          </TouchableOpacity>
        </LinearGradient>

        {/* ── LOAN HISTORY (collapsible) ──────────────────────────── */}
        <TouchableOpacity
          style={s.historyToggle}
          onPress={() => setShowHistory(v => !v)}
          activeOpacity={0.8}
        >
          <Ionicons name="time-outline" size={18} color="#2E7D32" />
          <Text style={s.historyToggleText}>Loan History</Text>
          <Ionicons name={showHistory ? 'chevron-up' : 'chevron-down'} size={16} color="#2E7D32" style={{ marginLeft: 'auto' }} />
        </TouchableOpacity>

        {showHistory && (
          <View style={{ gap: 12 }}>
            {historyLoading && (
              <View style={s.emptyRequests}>
                <Text style={s.emptySub}>Loading…</Text>
              </View>
            )}
            {!historyLoading && loanHistory.length === 0 && (
              <View style={s.emptyRequests}>
                <Text style={s.emptyEmoji}>📋</Text>
                <Text style={s.emptyTitle}>No history yet</Text>
                <Text style={s.emptySub}>Completed loans will appear here.</Text>
              </View>
            )}
            {loanHistory.map(loan => {
              const formatDate = (iso: string | null) => {
                if (!iso) return '—';
                return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
              };
              const counterparty = loan.isBorrower ? loan.funderName : loan.borrowerName;
              const counterpartyUser = loan.isBorrower ? loan.funderUsername : loan.borrowerUsername;
              const counterpartyEmoji = loan.isBorrower ? loan.funderEmoji : loan.borrowerEmoji;
              const counterpartyAvatar = loan.isBorrower ? loan.funderAvatarUrl : loan.borrowerAvatarUrl;

              return (
                <View key={loan.id} style={[s.cardOuter, { borderWidth: 1, borderColor: loan.repaidOnTime ? '#D1FAE5' : '#FEE2E2', borderRadius: 16 }]}>
                  <View style={s.cardInner}>
                    <View style={s.requestRow}>
                      <View style={s.reqAvatar}>
                        {counterpartyAvatar
                          ? <Image source={{ uri: counterpartyAvatar }} style={s.reqAvatarImg} resizeMode="cover" />
                          : <Text style={{ fontSize: 22 }}>{counterpartyEmoji}</Text>}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.reqName}>{loan.isBorrower ? 'Borrowed from' : 'Lent to'} @{counterpartyUser}</Text>
                        <Text style={s.reqSub}>{loan.reasonEmoji} {loan.reason}</Text>
                      </View>
                      <Text style={s.reqName}>£{fmtAmt(loan.amount)}</Text>
                    </View>

                    <View style={s.historyMeta}>
                      <View style={s.historyMetaItem}>
                        <Text style={s.historyMetaLabel}>Started</Text>
                        <Text style={s.historyMetaValue}>{formatDate(loan.createdAt)}</Text>
                      </View>
                      <View style={s.historyMetaDivider} />
                      <View style={s.historyMetaItem}>
                        <Text style={s.historyMetaLabel}>Repaid</Text>
                        <Text style={s.historyMetaValue}>{formatDate(loan.repaidAt)}</Text>
                      </View>
                      <View style={s.historyMetaDivider} />
                      <View style={s.historyMetaItem}>
                        <Text style={s.historyMetaLabel}>Status</Text>
                        <View style={[s.statusBadge, { backgroundColor: loan.repaidOnTime ? '#F0FDF4' : '#FEF2F2' }]}>
                          <Ionicons name={loan.repaidOnTime ? 'checkmark-circle' : 'close-circle'} size={13} color={loan.repaidOnTime ? '#16A34A' : colors.error} />
                          <Text style={[s.statusText, { color: loan.repaidOnTime ? '#16A34A' : colors.error }]}>
                            {loan.repaidOnTime ? 'On time' : loan.status === 'defaulted' ? 'Defaulted' : 'Late'}
                          </Text>
                        </View>
                      </View>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>

      {/* ── FRIEND PROFILE SHEET ───────────────────────────────── */}
      <Modal
        visible={selectedFriend !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedFriend(null)}
      >
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setSelectedFriend(null)}>
          <TouchableOpacity style={s.friendSheet} activeOpacity={1} onPress={() => {}}>
            {/* Close */}
            <TouchableOpacity style={s.sheetClose} onPress={() => setSelectedFriend(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color="#6B7280" />
            </TouchableOpacity>

            {/* Avatar */}
            <View style={s.sheetAvatarWrap}>
              {selectedFriend?.profileImageUrl ? (
                <Image source={{ uri: selectedFriend.profileImageUrl }} style={s.sheetAvatarImg} resizeMode="cover" />
              ) : (
                <Text style={s.sheetAvatarEmoji}>{selectedFriend?.avatarEmoji}</Text>
              )}
            </View>

            <Text style={s.sheetName}>{selectedFriend?.displayName}</Text>
            <Text style={s.sheetUsername}>@{selectedFriend?.username}</Text>
            <View style={s.sheetScorePill}>
              <Text style={s.sheetScoreText}>Trust Score {selectedFriend?.trustScore}</Text>
            </View>

            <View style={s.sheetDivider} />

            {/* Remove from Circle */}
            <TouchableOpacity
              style={s.removeBtn}
              activeOpacity={0.8}
              onPress={() => {
                if (selectedFriend) handleRemoveFriend(selectedFriend.id, selectedFriend.username);
              }}
            >
              <Ionicons name="person-remove-outline" size={18} color={colors.error} />
              <Text style={s.removeBtnText}>Remove from Circle</Text>
            </TouchableOpacity>

            {/* Block */}
            <TouchableOpacity
              style={s.safetyBtn}
              activeOpacity={0.8}
              onPress={() => {
                if (!selectedFriend) return;
                setSafetyTarget({ id: selectedFriend.id, displayName: selectedFriend.displayName, username: selectedFriend.username });
                setSelectedFriend(null);
              }}
            >
              <Ionicons name="ban-outline" size={18} color="#DC2626" />
              <Text style={[s.safetyBtnText, { color: '#DC2626' }]}>Block or Report</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── CONFIRM SHEETS (unchanged) ──────────────────────────── */}
      <ConfirmSheet
        visible={fundingRequest !== null}
        emoji="💚"
        title={`Fund ${fundingRequest?.fromName ?? ''}`}
        subtitle={`${fundingRequest?.reasonEmoji ?? ''} ${fundingRequest?.reason ?? ''}`}
        amount={fundingRequest?.amount ?? 0}
        balanceAfter={child.balance - (fundingRequest?.amount ?? 0)}
        confirmLabel={`Fund £${fmtAmt(fundingRequest?.amount ?? 0)}`}
        confirmColor="#2E7D32"
        onConfirm={confirmFund}
        onCancel={() => setFundingRequest(null)}
      />
      <ConfirmSheet
        visible={repayingRequest !== null}
        emoji="✅"
        title={`Repay ${repayingRequest?.fundedByName ?? ''}`}
        subtitle={`${repayingRequest?.reasonEmoji ?? ''} ${repayingRequest?.reason ?? ''}`}
        amount={repayingRequest?.amount ?? 0}
        balanceAfter={child.balance - (repayingRequest?.amount ?? 0)}
        confirmLabel={`Repay £${fmtAmt(repayingRequest?.amount ?? 0)}`}
        confirmColor="#16A34A"
        onConfirm={confirmRepay}
        onCancel={() => setRepayingRequest(null)}
      />

      {/* ── USER SAFETY SHEET (block / report) ─────────────────── */}
      <UserSafetySheet
        visible={safetyTarget !== null}
        target={safetyTarget}
        childId={childId}
        sessionToken={childSessionToken}
        deviceId={childDeviceId}
        onClose={() => setSafetyTarget(null)}
        onBlockSuccess={(blockedId) => {
          setCircle(prev => prev.filter(m => m.id !== blockedId));
          setPendingRequests(prev => prev.filter(r => r.id !== blockedId));
          setSafetyTarget(null);
        }}
      />
    </SafeAreaView>
  );
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const SCREEN_W   = Dimensions.get('window').width;
const SLOT_W     = (SCREEN_W - 32) / 5;   // 5 equal slots across the padded row
const FRIEND_SIZE = Math.round(SLOT_W * 0.78); // avatar is 78% of slot width

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: '#FFFFFF' },
  scroll: { backgroundColor: '#FFFFFF', paddingBottom: 16, gap: 16 },

  // Page header
  pageHeader:   { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  pageTitle:    { fontSize: 30, fontWeight: '800', color: '#111827', letterSpacing: -0.5 },
  pageSubtitle: { fontSize: 14, color: '#6B7280', fontWeight: '400', marginTop: 3 },

  // Friends row — outer container holds scrollable friends + fixed Add button
  friendsOuter:     { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 6, alignItems: 'flex-start' },
  friendsScroll:    { alignItems: 'flex-start' },
  friendSlot:       { width: SLOT_W, alignItems: 'center', gap: 6, paddingVertical: 6 },

  // Avatar is a wrapper that carries shadow/dot WITHOUT overflow:hidden,
  // so the online-dot isn't clipped by the ring's border-radius clip.
  friendAvatarOuter: { width: FRIEND_SIZE, height: FRIEND_SIZE, position: 'relative' },
  friendRingWrap:    { width: FRIEND_SIZE, height: FRIEND_SIZE, borderRadius: FRIEND_SIZE / 2, borderWidth: 2.5, borderColor: colors.primary, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primaryLight },
  friendPhoto:       { width: FRIEND_SIZE - 6, height: FRIEND_SIZE - 6, borderRadius: (FRIEND_SIZE - 6) / 2 },
  friendEmojiFill:   { width: FRIEND_SIZE, height: FRIEND_SIZE, alignItems: 'center', justifyContent: 'center' },
  onlineDot:         { position: 'absolute', bottom: 0, right: 0, width: 13, height: 13, borderRadius: 7, backgroundColor: '#22C55E', borderWidth: 2, borderColor: '#FFFFFF' },
  friendUsername:    { fontSize: 11, fontWeight: '600', color: '#374151', textAlign: 'center', width: SLOT_W - 4 },

  // Add Friend fixed slot
  addRingWrap: { width: FRIEND_SIZE, height: FRIEND_SIZE, borderRadius: FRIEND_SIZE / 2, borderWidth: 2, borderColor: colors.primary, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  addLabel:    { fontSize: 11, fontWeight: '700', color: '#2E7D32', textAlign: 'center' },

  // Card wrapper (outer = shadow, inner = clip)
  cardOuter: { marginHorizontal: 16, borderRadius: 16, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3 },
  cardInner: { borderRadius: 16, overflow: 'hidden' },

  // Card header
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F0F0F0' },
  cardTitleRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  cardTitle:     { fontSize: 22, fontWeight: '800', color: '#111827' },
  seeAllLink:    { fontSize: 14, fontWeight: '700', color: '#2E7D32' },
  countBadge:    { backgroundColor: colors.primaryLight, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  countBadgeText:{ fontSize: 12, fontWeight: '700', color: '#2E7D32' },

  // Requests card specific header (no "See all" link — just the title)
  reqCardHeader: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 0 },

  // Tab bar inside Requests card
  reqTabsWrap:     { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#F0F0F0', marginTop: 8 },
  reqTab:          { flex: 1, alignItems: 'center', paddingVertical: 14, position: 'relative' },
  reqTabText:      { fontSize: 15, fontWeight: '600', color: '#9CA3AF' },
  reqTabTextActive:{ fontSize: 15, fontWeight: '700', color: '#2E7D32' },
  reqTabIndicator: { position: 'absolute', bottom: 0, left: 16, right: 16, height: 2.5, backgroundColor: colors.primary, borderRadius: 2 },

  // Amount line in request rows (between name and sub-text)
  reqAmount: { fontSize: 14, fontWeight: '700', color: '#374151', marginBottom: 2 },

  // Cancel pill (matches Fund/Repay style for visual consistency)
  cancelPill:     { borderWidth: 1.5, borderColor: '#D1D5DB', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#FFFFFF' },
  cancelPillText: { fontSize: 13, fontWeight: '600', color: '#6B7280' },

  // Empty state
  emptyRequests: { alignItems: 'center', paddingVertical: 32, gap: 6 },
  emptyEmoji:    { fontSize: 34 },
  emptyTitle:    { fontSize: 15, fontWeight: '700', color: '#111827' },
  emptySub:      { fontSize: 13, color: '#6B7280', textAlign: 'center', paddingHorizontal: 16 },

  // Request rows
  reqRow:    { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 18 },
  requestRow:{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 18 },
  requestRowHighlight: { backgroundColor: '#F0FDF4', borderLeftWidth: 3, borderLeftColor: colors.primary, paddingLeft: 17 },
  staleLoanNote: { marginHorizontal: 20, marginBottom: 16, padding: 12, backgroundColor: '#FFF7ED', borderRadius: 10 },
  staleLoanText: { fontSize: 13, color: '#92400E', textAlign: 'center' },
  rowDivider:{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F0F0F0' },

  // Avatar with purple ring matching the screenshot
  reqAvatar:    { width: 54, height: 54, borderRadius: 27, borderWidth: 2, borderColor: colors.primary, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  reqAvatarImg: { width: 54, height: 54 },
  reqName:      { fontSize: 14, fontWeight: '600', color: '#111827', marginBottom: 2 },
  reqSub:       { fontSize: 13, fontWeight: '400', color: '#6B7280' },

  reqRight:   { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reqTimeCol: { alignItems: 'flex-end', gap: 2 },
  reqTime:  { fontSize: 12, fontWeight: '600', color: '#6B7280' },
  reqDue:   { fontSize: 11, color: '#9CA3AF' },

  // Compact pending friend request card
  frHeader:      { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F0F0F0' },
  frHeaderTitle: { fontSize: 13, fontWeight: '700', color: '#111827', flex: 1 },
  frReqRow:      { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  frReqAvatar:   { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: colors.primary, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  frReqAvatarImg:{ width: 36, height: 36 },
  frReqName:     { fontSize: 13, fontWeight: '600', color: '#111827' },
  frReqSub:      { fontSize: 11, color: '#6B7280', marginTop: 1 },
  frViewAll:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#F0F0F0' },
  frViewAllText: { fontSize: 12, fontWeight: '600', color: '#6B7280' },

  // Friend request accept/decline
  frActions:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  acceptBtn:  { backgroundColor: '#2E7D32', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  acceptText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
  declineBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },

  // Fund button — white background, purple border, pill-shaped
  fundBtn:     { borderWidth: 1.5, borderColor: colors.primary, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10, backgroundColor: '#FFFFFF' },
  fundBtnText: { fontSize: 14, fontWeight: '700', color: '#2E7D32' },

  // Repay button (pill style)
  repayPill:     { backgroundColor: '#F0FDF4', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1.5, borderColor: '#16A34A' },
  repayPillText: { fontSize: 14, fontWeight: '700', color: '#16A34A' },

  cancelText: { fontSize: 12, fontWeight: '600', color: '#9CA3AF', textDecorationLine: 'underline' },

  awaitPill: { backgroundColor: '#F0FDF4', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  awaitText: { fontSize: 11, fontWeight: '600', color: '#16A34A' },

  // "See all requests" footer — text left, arrow right
  viewAllToFund:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#F0F0F0' },
  viewAllToFundText: { fontSize: 13, fontWeight: '600', color: '#2E7D32' },
  seeAllFooter:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.primaryLight, paddingVertical: 16, paddingHorizontal: 20 },
  seeAllFooterText: { fontSize: 14, fontWeight: '700', color: '#2E7D32' },

  // ── Leaderboard purple card ────────────────────────────────────────────────
  ldrCard: { marginHorizontal: 16, borderRadius: 24, paddingTop: 16, paddingBottom: 16, overflow: 'hidden' },

  ldrHeader:   { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, marginBottom: 10 },
  ldrTrophy:   { fontSize: 20 },
  ldrTitle:    { fontSize: 17, fontWeight: '800', color: '#1F2937' },

  ldrColumns: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 8, marginBottom: 12 },
  ldrDivider: { width: 1, backgroundColor: 'rgba(255,255,255,0.2)', alignSelf: 'stretch' },

  ldrCol:      { flex: 1, alignItems: 'center', gap: 5, paddingVertical: 4 },
  ldrEmpty:    { flex: 1, color: 'rgba(0,0,0,0.55)', fontSize: 14, textAlign: 'center', padding: 24 },

  goldBadge:     { width: 26, height: 26, borderRadius: 13, backgroundColor: '#F59E0B', alignItems: 'center', justifyContent: 'center' },
  goldBadgeText: { fontSize: 13, fontWeight: '900', color: '#FFFFFF' },
  ldrRankNum:    { fontSize: 14, fontWeight: '700', color: 'rgba(0,0,0,0.6)', height: 22, lineHeight: 22 },

  ldrAvatarWrap:      { width: 58, height: 58, borderRadius: 29, overflow: 'hidden', borderWidth: 2.5, borderColor: 'rgba(0,0,0,0.15)', alignItems: 'center', justifyContent: 'center' },
  ldrAvatarWrap1:     { width: 70, height: 70, borderRadius: 35, overflow: 'hidden', borderWidth: 2.5, borderColor: '#F59E0B', alignItems: 'center', justifyContent: 'center' },
  ldrAvatarImg:       { width: 58, height: 58 },
  ldrAvatarImg1:      { width: 70, height: 70 },
  ldrAvatarFallback:  { width: 58, height: 58, backgroundColor: 'rgba(0,0,0,0.08)', alignItems: 'center', justifyContent: 'center' },
  ldrAvatarFallback1: { width: 70, height: 70, backgroundColor: 'rgba(0,0,0,0.08)', alignItems: 'center', justifyContent: 'center' },

  ldrName:      { fontSize: 12, fontWeight: '700', color: '#1F2937', textAlign: 'center' },
  ldrNameFirst: { fontSize: 13, fontWeight: '800' },
  ldrNameYou:   { color: '#2E7D32' },
  ldrPts:       { fontSize: 11, fontWeight: '400', color: 'rgba(0,0,0,0.55)', textAlign: 'center' },
  ldrPtsFirst:  { fontSize: 12, fontWeight: '600', color: 'rgba(0,0,0,0.75)' },

  fullLdrBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.08)', borderRadius: 14, paddingVertical: 12, marginHorizontal: 20 },
  fullLdrText: { fontSize: 15, fontWeight: '700', color: '#1F2937' },

  // ── History toggle & rows ─────────────────────────────────────────────────
  historyToggle:     { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, backgroundColor: colors.primaryLight, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14 },
  historyToggleText: { fontSize: 15, fontWeight: '700', color: '#2E7D32', flex: 1 },

  historyMeta:        { flexDirection: 'row', backgroundColor: '#F9FAFB', marginHorizontal: 16, marginBottom: 16, borderRadius: 12, overflow: 'hidden' },
  historyMetaItem:    { flex: 1, alignItems: 'center', paddingVertical: 10 },
  historyMetaLabel:   { fontSize: 11, color: '#9CA3AF', marginBottom: 3 },
  historyMetaValue:   { fontSize: 13, fontWeight: '700', color: '#111827' },
  historyMetaDivider: { width: 1, backgroundColor: '#E5E7EB' },
  statusBadge:        { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 3 },
  statusText:         { fontSize: 11, fontWeight: '700' },

  // ── Friend profile sheet ──────────────────────────────────────────────────
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  friendSheet:  {
    backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 24, paddingTop: 16, paddingBottom: 36,
    alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 20,
  },
  sheetClose: { alignSelf: 'flex-end', width: 36, height: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F3F4F6', borderRadius: 18, marginBottom: 8 },

  sheetAvatarWrap: { width: 80, height: 80, borderRadius: 40, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 2.5, borderColor: colors.primary, marginBottom: 12 },
  sheetAvatarImg:  { width: 80, height: 80 },
  sheetAvatarEmoji:{ fontSize: 38 },

  sheetName:     { fontSize: 22, fontWeight: '800', color: '#111827', marginBottom: 3 },
  sheetUsername: { fontSize: 15, color: '#6B7280', fontWeight: '500', marginBottom: 10 },
  sheetScorePill:{ backgroundColor: colors.primaryLight, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 5 },
  sheetScoreText:{ fontSize: 13, fontWeight: '700', color: '#2E7D32' },

  sheetDivider: { width: '100%', height: StyleSheet.hairlineWidth, backgroundColor: '#E5E7EB', marginVertical: 20 },

  removeBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', borderWidth: 1.5, borderColor: colors.error, borderRadius: 14, paddingVertical: 15 },
  removeBtnText: { fontSize: 15, fontWeight: '700', color: colors.error },
  safetyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: 14, backgroundColor: '#FEF2F2',
    marginTop: 8,
  },
  safetyBtnText: { fontSize: 15, fontWeight: '700' },
  moreBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#F3F4F6',
  },
});
