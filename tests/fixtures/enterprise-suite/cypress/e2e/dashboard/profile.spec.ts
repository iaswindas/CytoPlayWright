describe("Profile", () => {
  beforeEach(() => {
    cy.visit("/dashboard/profile");
  });

  it("updates the profile form", () => {
    cy.get("[data-testid='display-name']").type("Enterprise User");
    cy.get("[data-testid='timezone']").select("Asia/Calcutta");
    cy.get("[data-testid='marketing-opt-in']").check();
    cy.contains("Save profile").click();
    cy.contains("Profile updated").should("be.visible");
  });
});
