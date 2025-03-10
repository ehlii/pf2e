declare namespace foundry {
    module data {
        interface PrototypeTokenSource
            extends Omit<
                TokenSource,
                "_id" | "actorId" | "actorData" | "x" | "y" | "elevation" | "effects" | "overlayEffect" | "hidden"
            > {
            name: string;
            randomImg: boolean;
        }

        class PrototypeTokenData<
            TDocument extends documents.BaseActor = documents.BaseActor
        > extends abstract.DocumentData<TDocument> {
            static override defineSchema(): abstract.DocumentSchema;

            protected override _initialize(): void;

            override toJSON(): this["_source"];

            lightAnimation: AnimationData<TDocument>;

            bar1: TokenBarData<TDocument>;

            bar2: TokenBarData<TDocument>;
        }

        interface PrototypeTokenData extends Omit<PrototypeTokenSource, "lightAnimation" | "bar1" | "bar2"> {
            readonly _source: PrototypeTokenSource;
        }
    }
}
