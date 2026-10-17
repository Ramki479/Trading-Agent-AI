#!/usr/bin/env node
/**
 * atlas/agents/onchain.js — ATLAS On-Chain Agent.
 *
 * Where reliable data exists analyze:
 *   - holder concentration
 *   - liquidity ownership
 *   - token age
 *   - transaction activity
 *   - buy/sell imbalance
 *   - wallet concentration
 *   - suspicious wallet activity
 *
 * If data is unavailable -> NO_DATA. Never fabricate on-chain information.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function analyze(input = {}) {
  const cand = input.candidate || {};
  const integrity = input.integrity || {};
  const dq = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' ? 0 : 100;

  const holderConcentration = Number.isFinite(cand.holderConcentration) ? cand.holderConcentration : null;
  const topHolderPct = Number.isFinite(cand.topHolderPct) ? cand.topHolderPct : null;
  const top10HolderPct = Number.isFinite(cand.top10HolderPct) ? cand.top10HolderPct : null;
  const liquidityOwnedByTop = Number.isFinite(cand.liquidityOwnedByTop) ? cand.liquidityOwnedByTop : null;
  const tokenAgeDays = Number.isFinite(cand.tokenAgeDays) ? cand.tokenAgeDays : null;
  const transactionCount = Number.isFinite(cand.transactionCount) ? cand.transactionCount : null;
  const buysPct = Number.isFinite(cand.buysPct) ? cand.buysPct : null;
  const walletCount = Number.isFinite(cand.walletCount) ? cand.walletCount : null;
  const uniqueSellers = Number.isFinite(cand.uniqueSellers) ? cand.uniqueSellers : null;
  const uniqueBuyers = Number.isFinite(cand.uniqueBuyers) ? cand.uniqueBuyers : null;
  const suspiciousWallets = Array.isArray(cand.suspiciousWallets) ? cand.suspiciousWallets : null;
  const recentTxCount = Number.isFinite(cand.recentTxCount) ? cand.recentTxCount : null;
  const txGrowthPct = Number.isFinite(cand.txGrowthPct) ? cand.txGrowthPct : null;

  let direction = 'neutral';
  let reason = 'no on-chain data available';
  let confidence = 0;
  let score = 0;
  let status = 'NO_DATA';

  const evidence = [];
  const risks = [];
  const invalidatingConditions = [];

  if (dq === 0) {
    direction = 'unknown';
    reason = 'price-integrity flagged data as invalid/quarantined';
    status = 'NO_DATA';
  } else if (!holderConcentration && !topHolderPct && !tokenAgeDays && !transactionCount && !buysPct && !suspiciousWallets) {
    direction = 'neutral';
    reason = 'no on-chain data available';
    status = 'NO_DATA';
  } else {
    status = 'PARTIAL';
    let onchainScore = 50;
    let onchainDirection = 'neutral';

    // holder concentration risk
    if (topHolderPct != null) {
      if (topHolderPct > 50) {
        onchainDirection = 'bearish';
        evidence.push({ claim: 'top holder concentration', value: topHolderPct.toFixed(0) + '% of supply held by top holder', source: 'on_chain_data', confidence: clamp(60 + (topHolderPct - 50) * 0.8), timestamp: Date.now(), sourceDetail: 'top_holder_pct' });
        risks.push('high_holder_concentration');
        invalidatingConditions.push('top holder controls >50% of supply — dump risk');
      } else if (topHolderPct > 30) {
        evidence.push({ claim: 'top holder concentration', value: topHolderPct.toFixed(0) + '% of supply held by top holder', source: 'on_chain_data', confidence: clamp(50 + (topHolderPct - 30) * 1.5), timestamp: Date.now(), sourceDetail: 'top_holder_pct' });
        risks.push('moderate_holder_concentration');
      } else {
        evidence.push({ claim: 'top holder concentration', value: topHolderPct.toFixed(0) + '% of supply held by top holder', source: 'on_chain_data', confidence: clamp(40 + topHolderPct * 1.5), timestamp: Date.now(), sourceDetail: 'top_holder_pct' });
      }
    }

    if (top10HolderPct != null) {
      if (top10HolderPct > 90) {
        evidence.push({ claim: 'top 10 holder concentration', value: top10HolderPct.toFixed(0) + '% of supply held by top 10 holders', source: 'on_chain_data', confidence: clamp(55 + (top10HolderPct - 90) * 0.5), timestamp: Date.now(), sourceDetail: 'top_10_holder_pct' });
        risks.push('extreme_accumulation_concentration');
      } else {
        evidence.push({ claim: 'top 10 holder concentration', value: top10HolderPct.toFixed(0) + '% of supply held by top 10 holders', source: 'on_chain_data', confidence: clamp(40 + top10HolderPct * 0.5), timestamp: Date.now(), sourceDetail: 'top_10_holder_pct' });
      }
    }

    // liquidity ownership
    if (liquidityOwnedByTop != null && liquidityOwnedByTop > 50) {
      evidence.push({ claim: 'liquidity ownership', value: liquidityOwnedByTop.toFixed(0) + '% of liquidity owned by top holders', source: 'on_chain_data', confidence: clamp(55 + (liquidityOwnedByTop - 50) * 0.5), timestamp: Date.now(), sourceDetail: 'liquidity_owned_by_top' });
      risks.push('liquidity_concentrated_in_top_wallets');
      onchainDirection = 'bearish';
    } else if (liquidityOwnedByTop != null) {
      evidence.push({ claim: 'liquidity ownership', value: liquidityOwnedByTop.toFixed(0) + '% of liquidity owned by top holders', source: 'on_chain_data', confidence: clamp(35 + liquidityOwnedByTop * 0.5), timestamp: Date.now(), sourceDetail: 'liquidity_owned_by_top' });
    }

    // token age
    if (tokenAgeDays != null && tokenAgeDays > 0) {
      if (tokenAgeDays < 1) {
        evidence.push({ claim: 'token age', value: tokenAgeDays.toFixed(1) + ' days (very new)', source: 'on_chain_data', confidence: clamp(40), timestamp: Date.now(), sourceDetail: 'token_age_days' });
        risks.push('very_new_token');
        onchainDirection = 'bearish';
      } else if (tokenAgeDays < 7) {
        evidence.push({ claim: 'token age', value: tokenAgeDays.toFixed(1) + ' days', source: 'on_chain_data', confidence: clamp(35 + tokenAgeDays * 5), timestamp: Date.now(), sourceDetail: 'token_age_days' });
        onchainDirection = 'bearish';
      } else if (tokenAgeDays < 30) {
        evidence.push({ claim: 'token age', value: tokenAgeDays.toFixed(1) + ' days', source: 'on_chain_data', confidence: clamp(35 + tokenAgeDays * 1), timestamp: Date.now(), sourceDetail: 'token_age_days' });
      } else {
        evidence.push({ claim: 'token age', value: tokenAgeDays.toFixed(0) + ' days', source: 'on_chain_data', confidence: clamp(30 + Math.min(40, tokenAgeDays * 0.5)), timestamp: Date.now(), sourceDetail: 'token_age_days' });
      }
    }

    // buy/sell imbalance
    if (buysPct != null) {
      if (buysPct > 80) {
        evidence.push({ claim: 'buy/sell imbalance', value: buysPct.toFixed(0) + '% buys (strong buying pressure)', source: 'on_chain_data', confidence: clamp(50 + (buysPct - 80) * 1), timestamp: Date.now(), sourceDetail: 'buy_sell_imbalance' });
        onchainDirection = 'bullish';
      } else if (buysPct < 40) {
        evidence.push({ claim: 'buy/sell imbalance', value: buysPct.toFixed(0) + '% buys (selling pressure)', source: 'on_chain_data', confidence: clamp(50 + (40 - buysPct) * 1), timestamp: Date.now(), sourceDetail: 'buy_sell_imbalance' });
        onchainDirection = 'bearish';
      } else {
        evidence.push({ claim: 'buy/sell imbalance', value: buysPct.toFixed(0) + '% buys', source: 'on_chain_data', confidence: clamp(40 + Math.abs(buysPct - 50) * 2), timestamp: Date.now(), sourceDetail: 'buy_sell_imbalance' });
      }
    }

    // suspicious wallets
    if (suspiciousWallets && suspiciousWallets.length > 0) {
      evidence.push({ claim: 'suspicious wallet activity', value: suspiciousWallets.length + ' suspicious wallets identified', source: 'on_chain_data', confidence: clamp(60 + Math.min(40, suspiciousWallets.length * 8)), timestamp: Date.now(), sourceDetail: 'suspicious_wallets' });
      risks.push('suspicious_wallet_activity');
      onchainDirection = 'bearish';
      invalidatingConditions.push(suspiciousWallets.length + ' suspicious wallets — manipulation risk');
    }

    // transaction activity
    if (transactionCount != null && transactionCount > 0) {
      const txScore = clamp(transactionCount / 1000 * 10, 0, 100);
      evidence.push({ claim: 'transaction count', value: transactionCount.toLocaleString() + ' total transactions', source: 'on_chain_data', confidence: clamp(40 + txScore), timestamp: Date.now(), sourceDetail: 'transaction_count' });
      onchainScore = (onchainScore + txScore) / 2;
      if (recentTxCount != null) {
        evidence.push({ claim: 'recent transactions', value: recentTxCount.toLocaleString() + ' recent transactions', source: 'on_chain_data', confidence: clamp(40 + clamp(recentTxCount / 100 * 10, 0, 100)), timestamp: Date.now(), sourceDetail: 'recent_tx_count' });
      }
    }

    // tx growth
    if (txGrowthPct != null) {
      evidence.push({ claim: 'transaction growth', value: txGrowthPct.toFixed(1) + '% tx growth', source: 'on_chain_data', confidence: clamp(40 + Math.min(100, Math.abs(txGrowthPct) * 1.5)), timestamp: Date.now(), sourceDetail: 'tx_growth_pct' });
      if (txGrowthPct > 0) onchainDirection = 'bullish';
    }

    // unique buyers/sellers
    if (uniqueBuyers != null && uniqueSellers != null && uniqueSellers > 0) {
      const ratio = uniqueBuyers / uniqueSellers;
      evidence.push({ claim: 'unique buyer/seller ratio', value: ratio.toFixed(2) + ' (' + uniqueBuyers.toLocaleString() + ' buyers / ' + uniqueSellers.toLocaleString() + ' sellers)', source: 'on_chain_data', confidence: clamp(40 + clamp(Math.abs(ratio - 1) * 20, 0, 100)), timestamp: Date.now(), sourceDetail: 'buyer_seller_ratio' });
      if (ratio > 1.5) onchainDirection = 'bullish';
      else if (ratio < 0.7) onchainDirection = 'bearish';
    }

    // wallet count
    if (walletCount != null && walletCount > 0) {
      evidence.push({ claim: 'wallet count', value: walletCount.toLocaleString() + ' wallets', source: 'on_chain_data', confidence: clamp(30 + Math.min(70, walletCount / 1000 * 20)), timestamp: Date.now(), sourceDetail: 'wallet_count' });
    }

    // synthesize
    if (onchainDirection === 'bearish') {
      direction = 'bearish';
      reason = 'on-chain data shows risk signals (concentration/suspicious activity/weak imbalance)';
      confidence = clamp(35 + (onchainScore > 60 ? 10 : 0));
    } else if (onchainDirection === 'bullish' && (topHolderPct == null || topHolderPct < 30)) {
      direction = 'bullish';
      reason = 'on-chain data shows supportive signals (healthy distribution/activity)';
      confidence = clamp(35 + (onchainScore > 50 ? 10 : 0));
    } else {
      direction = 'neutral';
      reason = 'on-chain data mixed or incomplete';
      confidence = clamp(25 + (onchainScore > 50 ? 10 : 0));
    }

    score = clamp(Math.round(confidence));
    confidence = clamp(confidence);
  }

  return {
    agent: 'onchain',
    candidate: cand.symbol || '',
    timestamp: Date.now(),
    direction,
    confidence: Math.round(clamp(confidence)),
    score: Math.round(score),
    timeHorizon: '1h',
    thesis: reason,
    evidence,
    risks,
    invalidatingConditions,
    prediction: predictionObj(direction, score),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok',
    status
  };

  function predictionObj(direction, score) {
    if (direction === 'unknown') return { expectedMovePct: 0, probabilityUp: 0, probabilityDown: 0 };
    const base = clamp(score / 100);
    const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
    const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
    const expected = (direction === 'bullish' ? 1 : -1) * clamp(score / 15);
    return {
      expectedMovePct: Math.round(clamp(expected, -50, 50)),
      probabilityUp: clamp(up),
      probabilityDown: clamp(down)
    };
  }
}

module.exports = { analyze };
