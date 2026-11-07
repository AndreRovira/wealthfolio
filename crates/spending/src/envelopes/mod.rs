//! Envelopes — money pots funded on a pay cycle (biweekly, monthly, or when an
//! income deposit lands), independent of the monthly budget. A pot's balance is
//! the sum of its ledger entries minus the spend in the categories linked to it
//! since its start date. Categories that are not linked never touch a pot.

pub mod model;
pub mod service;
pub mod traits;

pub use model::*;
pub use service::EnvelopeService;
pub use traits::EnvelopeRepositoryTrait;
