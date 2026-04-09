describe("Scoped dashboard form", () => {
  beforeEach(() => {
    cy.visit("/dashboard/scoped");
  });

  it("uses within to scope nested locators", () => {
    cy.get("[data-testid='profile-form']").within(() => {
      cy.get("[data-testid='email']").type("person@example.com");
      cy.contains("Save").click();
    });

    cy.contains("Saved").should("be.visible");
  });
});
