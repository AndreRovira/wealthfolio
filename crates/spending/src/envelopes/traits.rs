use anyhow::Result;
use async_trait::async_trait;
use chrono::NaiveDate;

use super::model::*;

#[async_trait]
pub trait EnvelopeRepositoryTrait: Send + Sync {
    async fn list_envelopes(&self) -> Result<Vec<Envelope>>;
    async fn create_envelope(&self, input: EnvelopeInput) -> Result<Envelope>;
    async fn update_envelope(&self, id: &str, input: EnvelopeInput) -> Result<Envelope>;
    async fn delete_envelope(&self, id: &str) -> Result<()>;

    async fn list_bills(&self) -> Result<Vec<EnvelopeBill>>;
    async fn create_bill(&self, input: EnvelopeBillInput) -> Result<EnvelopeBill>;
    async fn update_bill(&self, id: &str, input: EnvelopeBillInput) -> Result<EnvelopeBill>;
    async fn delete_bill(&self, id: &str) -> Result<()>;
    /// Move a bill's next due date (payment registered or marked by hand).
    async fn set_bill_next_due(&self, id: &str, next_due: Option<NaiveDate>) -> Result<()>;
    /// Move a bill from due date `from` to `to` and write `sweep` with it, in
    /// one transaction. False, with nothing written, when the bill is no
    /// longer due on `from`: someone else settled it first.
    async fn settle_bill(
        &self,
        id: &str,
        from: NaiveDate,
        to: NaiveDate,
        sweep: Vec<NewEnvelopeEntry>,
    ) -> Result<bool>;

    async fn list_links(&self) -> Result<Vec<EnvelopeCategoryLink>>;
    /// Replace every link that points at `envelope_id` with `links`.
    async fn replace_links(
        &self,
        envelope_id: &str,
        links: Vec<EnvelopeCategoryLink>,
    ) -> Result<()>;

    async fn list_entries(
        &self,
        envelope_id: Option<&str>,
        from: Option<NaiveDate>,
    ) -> Result<Vec<EnvelopeEntry>>;
    async fn insert_entries(&self, entries: Vec<NewEnvelopeEntry>) -> Result<Vec<EnvelopeEntry>>;
    async fn delete_entry(&self, id: &str) -> Result<()>;
    /// Delete both legs of a move.
    async fn delete_move(&self, move_id: &str) -> Result<()>;

    async fn list_rules(&self) -> Result<Vec<FundingRule>>;
    async fn create_rule(&self, input: FundingRuleInput) -> Result<FundingRule>;
    async fn update_rule(&self, id: &str, input: FundingRuleInput) -> Result<FundingRule>;
    async fn delete_rule(&self, id: &str) -> Result<()>;
}
