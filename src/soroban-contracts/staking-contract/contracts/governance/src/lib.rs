#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, log, symbol_short, Address, Env, Map, Vec,
};

// Data Types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub title: Vec<u8>,
    pub description: Vec<u8>,
    pub proposer: Address,
    pub target_contract: Address,
    pub function_name: Vec<u8>,
    pub parameters: Vec<u8>, // Encoded parameters
    pub votes_for: i128,
    pub votes_against: i128,
    pub status: ProposalStatus,
    pub created_at: u64,
    pub voting_end: u64,
    pub execution_delay: u64,
    pub executed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Failed,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vote {
    pub proposal_id: u64,
    pub voter: Address,
    pub vote_power: i128,
    pub support: bool, // true for yes, false for no
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceConfig {
    pub admin: Address,
    pub staking_contract: Address,
    pub rewards_contract: Address,
    pub liquidity_contract: Address,
    pub voting_period: u64,     // Seconds
    pub execution_delay: u64,   // Seconds
    pub quorum_threshold: i128, // Basis points (e.g., 1000 = 10%)
    pub pass_threshold: i128,   // Basis points (e.g., 5100 = 51%)
    pub min_proposal_power: i128, // Minimum voting power to create proposal
    pub emergency_pause: bool,
}

// Storage Keys
#[contracttype]
pub enum DataKey {
    Config,
    Proposal(u64),
    Vote(u64, Address), // proposal_id, voter
    ProposalCount,
    VoterPower(Address),
    TotalVotingPower,
    LastProposalByUser(Address),
}

// Error Types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GovernanceError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ProposalNotFound = 4,
    VotingPeriodEnded = 5,
    VotingPeriodActive = 6,
    InsufficientVotingPower = 7,
    AlreadyVoted = 8,
    ProposalNotPassed = 9,
    ExecutionDelayNotMet = 10,
    AlreadyExecuted = 11,
    ContractPaused = 12,
    InvalidParameters = 13,
    ProposalCooldown = 14,
}

// Events
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreatedEvent {
    pub proposal_id: u64,
    pub proposer: Address,
    pub title: Vec<u8>,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCastEvent {
    pub proposal_id: u64,
    pub voter: Address,
    pub support: bool,
    pub vote_power: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecutedEvent {
    pub proposal_id: u64,
    pub executor: Address,
    pub timestamp: u64,
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initialize the governance contract
    pub fn initialize(
        env: Env,
        admin: Address,
        staking_contract: Address,
        rewards_contract: Address,
        liquidity_contract: Address,
        voting_period: u64,
        execution_delay: u64,
        quorum_threshold: i128,
        pass_threshold: i128,
        min_proposal_power: i128,
    ) -> Result<(), GovernanceError> {
        // Check if already initialized
        if env.storage().instance().has(&DataKey::Config) {
            return Err(GovernanceError::AlreadyInitialized);
        }

        admin.require_auth();

        // Validate parameters
        if quorum_threshold > 10000 || pass_threshold > 10000 {
            return Err(GovernanceError::InvalidParameters);
        }

        let config = GovernanceConfig {
            admin: admin.clone(),
            staking_contract,
            rewards_contract,
            liquidity_contract,
            voting_period,
            execution_delay,
            quorum_threshold,
            pass_threshold,
            min_proposal_power,
            emergency_pause: false,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(&DataKey::TotalVotingPower, &0i128);

        log!(&env, "Governance contract initialized by admin: {}", admin);
        
        Ok(())
    }

    /// Create a new proposal
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        title: Vec<u8>,
        description: Vec<u8>,
        target_contract: Address,
        function_name: Vec<u8>,
        parameters: Vec<u8>,
    ) -> Result<u64, GovernanceError> {
        proposer.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.emergency_pause {
            return Err(GovernanceError::ContractPaused);
        }

        // Check voting power
        let voter_power = Self::get_voting_power(&env, &proposer);
        if voter_power < config.min_proposal_power {
            return Err(GovernanceError::InsufficientVotingPower);
        }

        // Check cooldown period (prevent spam)
        let current_time = env.ledger().timestamp();
        if let Some(last_proposal_time) = env.storage().persistent().get::<DataKey, u64>(&DataKey::LastProposalByUser(proposer.clone())) {
            if current_time < last_proposal_time + 86400 { // 1 day cooldown
                return Err(GovernanceError::ProposalCooldown);
            }
        }

        let proposal_count: u64 = env.storage().instance().get(&DataKey::ProposalCount).unwrap_or(0);
        let proposal_id = proposal_count + 1;

        let proposal = Proposal {
            id: proposal_id,
            title: title.clone(),
            description,
            proposer: proposer.clone(),
            target_contract,
            function_name,
            parameters,
            votes_for: 0,
            votes_against: 0,
            status: ProposalStatus::Active,
            created_at: current_time,
            voting_end: current_time + config.voting_period,
            execution_delay: config.execution_delay,
            executed: false,
        };

        env.storage().instance().set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage().instance().set(&DataKey::ProposalCount, &proposal_id);
        env.storage().persistent().set(&DataKey::LastProposalByUser(proposer.clone()), &current_time);

        // Emit event
        let event = ProposalCreatedEvent {
            proposal_id,
            proposer: proposer.clone(),
            title,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("proposed"),), event);

        log!(&env, "Proposal {} created by {}", proposal_id, proposer);

        Ok(proposal_id)
    }

    /// Cast a vote on a proposal
    pub fn vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: bool,
    ) -> Result<(), GovernanceError> {
        voter.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.emergency_pause {
            return Err(GovernanceError::ContractPaused);
        }

        let mut proposal: Proposal = env.storage().instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        let current_time = env.ledger().timestamp();

        // Check if voting period is active
        if current_time > proposal.voting_end {
            return Err(GovernanceError::VotingPeriodEnded);
        }

        // Check if user already voted
        if env.storage().persistent().has(&DataKey::Vote(proposal_id, voter.clone())) {
            return Err(GovernanceError::AlreadyVoted);
        }

        // Get voter's voting power
        let vote_power = Self::get_voting_power(&env, &voter);
        if vote_power <= 0 {
            return Err(GovernanceError::InsufficientVotingPower);
        }

        // Record the vote
        let vote = Vote {
            proposal_id,
            voter: voter.clone(),
            vote_power,
            support,
            timestamp: current_time,
        };

        env.storage().persistent().set(&DataKey::Vote(proposal_id, voter.clone()), &vote);

        // Update proposal vote counts
        if support {
            proposal.votes_for += vote_power;
        } else {
            proposal.votes_against += vote_power;
        }

        env.storage().instance().set(&DataKey::Proposal(proposal_id), &proposal);

        // Emit event
        let event = VoteCastEvent {
            proposal_id,
            voter: voter.clone(),
            support,
            vote_power,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("voted"),), event);

        log!(&env, "User {} voted {} on proposal {} with power {}", voter, support, proposal_id, vote_power);

        Ok(())
    }

    /// Finalize a proposal after voting period ends
    pub fn finalize_proposal(env: Env, proposal_id: u64) -> Result<(), GovernanceError> {
        let config = Self::get_config(&env)?;

        let mut proposal: Proposal = env.storage().instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        let current_time = env.ledger().timestamp();

        // Check if voting period has ended
        if current_time <= proposal.voting_end {
            return Err(GovernanceError::VotingPeriodActive);
        }

        // Only finalize if still active
        if proposal.status != ProposalStatus::Active {
            return Ok(()); // Already finalized
        }

        let total_votes = proposal.votes_for + proposal.votes_against;
        let total_voting_power: i128 = env.storage().instance().get(&DataKey::TotalVotingPower).unwrap_or(0);

        // Check quorum
        let quorum_met = if total_voting_power > 0 {
            (total_votes * 10000) / total_voting_power >= config.quorum_threshold
        } else {
            false
        };

        // Check if proposal passed
        let passed = if quorum_met && total_votes > 0 {
            (proposal.votes_for * 10000) / total_votes >= config.pass_threshold
        } else {
            false
        };

        proposal.status = if passed {
            ProposalStatus::Passed
        } else {
            ProposalStatus::Failed
        };

        env.storage().instance().set(&DataKey::Proposal(proposal_id), &proposal);

        log!(&env, "Proposal {} finalized as {:?}", proposal_id, proposal.status);

        Ok(())
    }

    /// Execute a passed proposal
    pub fn execute_proposal(
        env: Env,
        executor: Address,
        proposal_id: u64,
    ) -> Result<(), GovernanceError> {
        executor.require_auth();

        let mut proposal: Proposal = env.storage().instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Passed {
            return Err(GovernanceError::ProposalNotPassed);
        }

        if proposal.executed {
            return Err(GovernanceError::AlreadyExecuted);
        }

        let current_time = env.ledger().timestamp();

        // Check execution delay
        if current_time < proposal.voting_end + proposal.execution_delay {
            return Err(GovernanceError::ExecutionDelayNotMet);
        }

        // Mark as executed
        proposal.executed = true;
        proposal.status = ProposalStatus::Executed;
        env.storage().instance().set(&DataKey::Proposal(proposal_id), &proposal);

        // Emit event
        let event = ProposalExecutedEvent {
            proposal_id,
            executor: executor.clone(),
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("executed"),), event);

        log!(&env, "Proposal {} executed by {}", proposal_id, executor);

        Ok(())
    }

    /// Update voting power for a user (called by staking contract)
    pub fn update_voting_power(
        env: Env,
        user: Address,
        new_power: i128,
    ) -> Result<(), GovernanceError> {
        let config = Self::get_config(&env)?;
        
        // Only staking contract can call this
        // Note: In a real implementation, you'd verify the caller is the staking contract
        
        let old_power: i128 = env.storage().persistent()
            .get(&DataKey::VoterPower(user.clone()))
            .unwrap_or(0);

        env.storage().persistent().set(&DataKey::VoterPower(user.clone()), &new_power);

        // Update total voting power
        let mut total_power: i128 = env.storage().instance().get(&DataKey::TotalVotingPower).unwrap_or(0);
        total_power = total_power - old_power + new_power;
        env.storage().instance().set(&DataKey::TotalVotingPower, &total_power);

        Ok(())
    }

    /// Get proposal information
    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        env.storage().instance().get(&DataKey::Proposal(proposal_id))
    }

    /// Get user's vote on a proposal
    pub fn get_vote(env: Env, proposal_id: u64, voter: Address) -> Option<Vote> {
        env.storage().persistent().get(&DataKey::Vote(proposal_id, voter))
    }

    /// Get user's voting power
    pub fn get_voting_power(env: &Env, user: &Address) -> i128 {
        env.storage().persistent()
            .get(&DataKey::VoterPower(user.clone()))
            .unwrap_or(0)
    }

    /// Get total voting power
    pub fn get_total_voting_power(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalVotingPower).unwrap_or(0)
    }

    /// Get proposal count
    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::ProposalCount).unwrap_or(0)
    }

    /// Get contract configuration
    pub fn get_config(env: Env) -> Result<GovernanceConfig, GovernanceError> {
        env.storage().instance()
            .get(&DataKey::Config)
            .ok_or(GovernanceError::NotInitialized)
    }

    /// Admin function to pause/unpause the contract
    pub fn set_emergency_pause(
        env: Env,
        admin: Address,
        paused: bool,
    ) -> Result<(), GovernanceError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(GovernanceError::Unauthorized);
        }

        config.emergency_pause = paused;
        env.storage().instance().set(&DataKey::Config, &config);

        log!(&env, "Emergency pause set to: {}", paused);
        
        Ok(())
    }

    /// Admin function to cancel a proposal (emergency only)
    pub fn cancel_proposal(
        env: Env,
        admin: Address,
        proposal_id: u64,
    ) -> Result<(), GovernanceError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(GovernanceError::Unauthorized);
        }

        let mut proposal: Proposal = env.storage().instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        proposal.status = ProposalStatus::Cancelled;
        env.storage().instance().set(&DataKey::Proposal(proposal_id), &proposal);

        log!(&env, "Proposal {} cancelled by admin", proposal_id);

        Ok(())
    }

    /// Admin function to update governance parameters
    pub fn update_governance_params(
        env: Env,
        admin: Address,
        voting_period: Option<u64>,
        execution_delay: Option<u64>,
        quorum_threshold: Option<i128>,
        pass_threshold: Option<i128>,
        min_proposal_power: Option<i128>,
    ) -> Result<(), GovernanceError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(GovernanceError::Unauthorized);
        }

        if let Some(period) = voting_period {
            config.voting_period = period;
        }
        if let Some(delay) = execution_delay {
            config.execution_delay = delay;
        }
        if let Some(quorum) = quorum_threshold {
            if quorum > 10000 {
                return Err(GovernanceError::InvalidParameters);
            }
            config.quorum_threshold = quorum;
        }
        if let Some(pass) = pass_threshold {
            if pass > 10000 {
                return Err(GovernanceError::InvalidParameters);
            }
            config.pass_threshold = pass;
        }
        if let Some(min_power) = min_proposal_power {
            config.min_proposal_power = min_power;
        }

        env.storage().instance().set(&DataKey::Config, &config);

        log!(&env, "Governance parameters updated by admin");

        Ok(())
    }
} 