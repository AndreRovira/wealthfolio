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
