import { LocalizePF2e } from "@module/system/localize";
import { ConsumableData, ConsumableType } from "./data";
import { ItemPF2e, PhysicalItemPF2e, SpellcastingEntryPF2e, SpellPF2e, WeaponPF2e } from "@item";
import { ErrorPF2e } from "@util";
import { ChatMessagePF2e } from "@module/chat-message";
import { TrickMagicItemPopup } from "@actor/sheet/trick-magic-item-popup";
import { TrickMagicItemEntry } from "@item/spellcasting-entry/trick";

class ConsumablePF2e extends PhysicalItemPF2e {
    get consumableType(): ConsumableType {
        return this.system.consumableType.value;
    }

    get isAmmunition(): boolean {
        return this.consumableType === "ammo";
    }

    get charges() {
        return {
            value: this.system.charges.value,
            current: this.system.charges.value, // will be removed in v10
            max: this.system.charges.max,
        };
    }

    /** Should this item be automatically destroyed upon use */
    get autoDestroy(): boolean {
        return this.system.autoDestroy.value;
    }

    get embeddedSpell(): Embedded<SpellPF2e> | null {
        const spellData = deepClone(this.system.spell.data);

        if (!spellData) return null;
        if (!this.actor) throw ErrorPF2e(`No owning actor found for "${this.name}" (${this.id})`);

        const heightenedLevel = this.system.spell.heightenedLevel;
        if (typeof heightenedLevel === "number") {
            spellData.data.location.heightenedLevel = heightenedLevel;
        }

        return new SpellPF2e(spellData, {
            parent: this.actor,
            fromConsumable: true,
        }) as Embedded<SpellPF2e>;
    }

    override getChatData(this: Embedded<ConsumablePF2e>, htmlOptions: EnrichHTMLOptions = {}): Record<string, unknown> {
        const systemData = this.system;
        const translations = LocalizePF2e.translations.PF2E;
        const traits = this.traitChatData(CONFIG.PF2E.consumableTraits);
        const [consumableType, isUsable] = this.isIdentified
            ? [game.i18n.localize(this.consumableType), true]
            : [
                  this.generateUnidentifiedName({ typeOnly: true }),
                  !["other", "scroll", "talisman", "tool", "wand"].includes(this.consumableType),
              ];

        return this.processChatData(htmlOptions, {
            ...systemData,
            traits,
            properties:
                this.isIdentified && this.charges.max > 0
                    ? [`${systemData.charges.value}/${systemData.charges.max} ${translations.ConsumableChargesLabel}`]
                    : [],
            usesCharges: this.charges.max > 0,
            hasCharges: this.charges.max > 0 && this.charges.value > 0,
            consumableType,
            isUsable,
        });
    }

    override generateUnidentifiedName({ typeOnly = false }: { typeOnly?: boolean } = { typeOnly: false }): string {
        const translations = LocalizePF2e.translations.PF2E.identification;
        const liquidOrSubstance = () =>
            this.traits.has("inhaled") || this.traits.has("contact")
                ? translations.UnidentifiedType.Substance
                : translations.UnidentifiedType.Liquid;
        const itemType = ["drug", "elixir", "mutagen", "oil", "poison", "potion"].includes(this.consumableType)
            ? liquidOrSubstance()
            : ["scroll", "snare", "ammo"].includes(this.consumableType)
            ? game.i18n.localize(CONFIG.PF2E.consumableTypes[this.consumableType])
            : translations.UnidentifiedType.Object;

        if (typeOnly) return itemType;

        const formatString = LocalizePF2e.translations.PF2E.identification.UnidentifiedItem;
        return game.i18n.format(formatString, { item: itemType });
    }

    isAmmoFor(weapon: ItemPF2e): boolean {
        if (!(weapon instanceof WeaponPF2e)) {
            console.warn("Cannot load a consumable into a non-weapon");
            return false;
        }

        const { max } = this.charges;
        return weapon.traits.has("repeating") ? max > 1 : max <= 1;
    }

    /** Use a consumable item, sending the result to chat */
    async consume(this: Embedded<ConsumablePF2e>): Promise<void> {
        const { value, max } = this.charges;

        if (["scroll", "wand"].includes(this.system.consumableType.value) && this.system.spell.data) {
            if (this.actor.spellcasting.canCastConsumable(this)) {
                this.castEmbeddedSpell();
            } else if (this.actor.itemTypes.feat.some((feat) => feat.slug === "trick-magic-item")) {
                new TrickMagicItemPopup(this);
            } else {
                const content = game.i18n.format("PF2E.LackCastConsumableCapability", { name: this.name });
                await ChatMessagePF2e.create({
                    user: game.user.id,
                    speaker: ChatMessage.getSpeaker({ actor: this.actor }),
                    whisper: ChatMessage.getWhisperRecipients(this.actor.name).map((user) => user.id),
                    content,
                });
            }
        } else {
            const exhausted = max > 1 && value === 1;
            const key = exhausted ? "UseExhausted" : max > 1 ? "UseMulti" : "UseSingle";
            const content = game.i18n.format(`PF2E.ConsumableMessage.${key}`, {
                name: this.name,
                current: value - 1,
            });

            // If using this consumable creates a roll, we need to show it
            const formula = this.system.consume.value;
            if (formula) {
                new Roll(formula).toMessage({
                    speaker: ChatMessage.getSpeaker({ actor: this.actor }),
                    flavor: content,
                });
            } else if (this.consumableType !== "ammo") {
                ChatMessage.create({
                    user: game.user.id,
                    speaker: ChatMessage.getSpeaker({ actor: this.actor }),
                    content,
                });
            }
        }

        const quantity = this.quantity;

        // Optionally destroy the item
        if (this.autoDestroy && value <= 1) {
            if (quantity <= 1) {
                await this.delete();
            } else {
                // Deduct one from quantity if this item has one charge or doesn't have charges
                await this.update({
                    "system.quantity": Math.max(quantity - 1, 0),
                    "system.charges.value": max,
                });
            }
        } else {
            // Deduct one charge
            await this.update({
                "system.charges.value": Math.max(value - 1, 0),
            });
        }
    }

    async castEmbeddedSpell(this: Embedded<ConsumablePF2e>, trickMagicItemData?: TrickMagicItemEntry): Promise<void> {
        const spell = this.embeddedSpell;
        if (!spell) return;
        const actor = this.actor;

        // Filter to only spellcasting entries that are eligible to cast this consumable
        const entry = (() => {
            if (trickMagicItemData) return trickMagicItemData;

            const spellcastingEntries = actor.spellcasting.spellcastingFeatures.filter((entry) =>
                spell.traditions.has(entry.tradition)
            );

            let maxBonus = 0;
            let bestEntry = 0;
            for (let i = 0; i < spellcastingEntries.length; i++) {
                if (spellcastingEntries[i].system.spelldc.value > maxBonus) {
                    maxBonus = spellcastingEntries[i].system.spelldc.value;
                    bestEntry = i;
                }
            }

            return spellcastingEntries[bestEntry];
        })();

        if (entry) {
            const systemData = spell.system;
            if (entry instanceof SpellcastingEntryPF2e) {
                systemData.location.value = entry.id;
            }

            entry.cast(spell, { consume: false });
        }
    }
}

interface ConsumablePF2e {
    readonly data: ConsumableData;
}

export { ConsumablePF2e };
