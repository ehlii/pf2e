import { UserPF2e } from "@module/user";
import { sluggify } from "@util";
import { ItemPF2e } from "../base";
import { EffectData } from "./data";

class EffectPF2e extends ItemPF2e {
    static DURATION_UNITS: Readonly<Record<string, number>> = {
        rounds: 6,
        minutes: 60,
        hours: 3600,
        days: 86400,
    };

    get level(): number {
        return this.system.level.value;
    }

    get isExpired(): boolean {
        return this.system.expired;
    }

    get totalDuration(): number {
        const { duration } = this.system;
        if (["unlimited", "encounter"].includes(duration.unit)) {
            return Infinity;
        } else {
            return duration.value * (EffectPF2e.DURATION_UNITS[duration.unit] ?? 0);
        }
    }

    get remainingDuration(): { expired: boolean; remaining: number } {
        const duration = this.totalDuration;
        if (this.system.duration.unit === "encounter") {
            const isExpired = this.system.expired;
            return { expired: isExpired, remaining: isExpired ? 0 : Infinity };
        } else if (duration === Infinity) {
            return { expired: false, remaining: Infinity };
        } else {
            const start = this.system.start?.value ?? 0;
            const remaining = start + duration - game.time.worldTime;
            const result = { remaining, expired: remaining <= 0 };
            if (
                result.remaining === 0 &&
                ui.combat !== undefined &&
                game.combat?.active &&
                game.combat.combatant &&
                game.combat.turns.length > game.combat.turn
            ) {
                const initiative = game.combat.combatant.initiative ?? 0;
                if (initiative === this.system.start.initiative) {
                    result.expired = this.system.duration.expiry !== "turn-end";
                } else {
                    result.expired = initiative < (this.system.start.initiative ?? 0);
                }
            }
            return result;
        }
    }

    /** Does this effect originate from an aura? */
    get fromAura(): boolean {
        return !!this.flags.pf2e.aura;
    }

    override prepareBaseData(): void {
        super.prepareBaseData();
        const { duration } = this.system;
        if (["unlimited", "encounter"].includes(duration.unit)) {
            duration.expiry = null;
        } else {
            duration.expiry ||= "turn-start";
        }
    }

    /** Set a self roll option for this effect */
    override prepareActorData(this: Embedded<EffectPF2e>): void {
        const slug = this.slug ?? sluggify(this.name);
        const reducedSlug = slug.replace(/^(?:[a-z]+-)?(?:effect|stance)-/, "");
        this.actor.rollOptions.all[`self:effect:${reducedSlug}`] = true;
    }

    /** Include a trimmed version of the "slug" roll option (e.g., effect:rage instead of effect:effect-rage) */
    override getRollOptions(prefix = this.type): string[] {
        const slug = this.slug ?? sluggify(this.name);
        const delimitedPrefix = prefix ? `${prefix}:` : "";
        const trimmedSlug = slug.replace(/^(?:spell-)?(?:effect|stance)-/, "");

        const options = super.getRollOptions(prefix);
        options.findSplice((o) => o === `${delimitedPrefix}${slug}`, `${delimitedPrefix}${trimmedSlug}`);

        return options;
    }

    /* -------------------------------------------- */
    /*  Event Listeners and Handlers                */
    /* -------------------------------------------- */

    /** Set the start time and initiative roll of a newly created effect */
    protected override async _preCreate(
        data: PreDocumentId<this["data"]["_source"]>,
        options: DocumentModificationContext<this>,
        user: UserPF2e
    ): Promise<void> {
        if (this.isOwned && user.id === game.userId) {
            const initiative = game.combat?.turns[game.combat.turn]?.initiative ?? null;
            this.data.update({
                "system.start": {
                    value: game.time.worldTime,
                    initiative: game.combat && game.combat.turns.length > game.combat.turn ? initiative : null,
                },
            });
        }
        await super._preCreate(data, options, user);
    }

    protected override async _preUpdate(
        changed: DeepPartial<this["data"]["_source"]>,
        options: DocumentModificationContext<this>,
        user: UserPF2e
    ): Promise<void> {
        const duration = changed.data?.duration;
        if (duration?.unit === "unlimited") {
            duration.expiry = null;
        } else if (typeof duration?.unit === "string" && !["unlimited", "encounter"].includes(duration.unit)) {
            duration.expiry ||= "turn-start";
            if (duration.value === -1) duration.value = 1;
        }

        return super._preUpdate(changed, options, user);
    }

    /** Show floaty text when this effect is created on an actor */
    protected override _onCreate(
        data: this["data"]["_source"],
        options: DocumentModificationContext<this>,
        userId: string
    ): void {
        super._onCreate(data, options, userId);

        this.actor?.getActiveTokens().shift()?.showFloatyText({ create: this });
    }

    /** Show floaty text when this effect is deleted from an actor */
    protected override _onDelete(options: DocumentModificationContext, userId: string): void {
        if (this.actor) {
            game.pf2e.effectTracker.unregister(this as Embedded<EffectPF2e>);
        }
        super._onDelete(options, userId);

        this.actor?.getActiveTokens().shift()?.showFloatyText({ delete: this });
    }
}

interface EffectPF2e {
    readonly data: EffectData;
}

export { EffectPF2e };
