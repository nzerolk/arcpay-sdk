import {type WalletAccount, WalletManager} from "@txnlab/use-wallet";
import {AppProvider, load} from "@/lib/app";
import {interfaces} from "@/lib/contracts/interfaces";
import type {TransactionConfirmation} from "@/lib/transaction/Transaction";
import type {NetworksConfig} from "@/lib/algod/networks.config";
import type {Database} from "@/lib/supabase/database.types";
import algosdk from "algosdk";

type ListingParams = Database['public']['Functions']['get_listing_by_id']['Returns']

export async function buy(networkConfig: NetworksConfig, appProvider: AppProvider, walletManager: WalletManager, account: WalletAccount, params: ListingParams, price: number): Promise<TransactionConfirmation> {
    const chainInterface = interfaces[networkConfig.chain]

    load(appProvider, 'Awaiting transaction confirmation', 'Please check your wallet and sign the transaction.')
    // Buy
    if (params.type === 'sale' || params.type === 'dutch') {
        //@ts-ignore
        const transactionConfirmation: TransactionConfirmation = await chainInterface[params.currency_type][params.asset_type][params.type].buy(
            walletManager.algodClient,
            walletManager.transactionSigner,
            account.address,
            ...formatCurrency(params),
            ...formatNftID(params),
            params.app_id,
            params.seller_address,
            price,
            algosdk.getApplicationAddress(networkConfig.feesAppId),
            networkConfig.feesAppId,
        )
        if (transactionConfirmation.txIDs.length === 0) throw new Error('Unexpected error: Buying listing failed.')
        return transactionConfirmation
    }

    // Bid
    if (params.type === 'auction') {
        //@ts-ignore
        const transactionConfirmation: TransactionConfirmation = await chainInterface[params.currency_type][params.asset_type]['auction'].bid(
            walletManager.algodClient,
            walletManager.transactionSigner,
            account.address,
            ...formatCurrency(params),
            params.app_id,
            price
        )
        if (transactionConfirmation.txIDs.length === 0) throw new Error('Unexpected error: Bidding on listing failed.')
        return transactionConfirmation
    }

    throw new Error(`Unexpected error: Invalid listing type ${params.type}`)
}

function formatCurrency(params: ListingParams): (number | string)[] {
    const args: (number | string)[] = []
    try {
        if (params.currency_type === 'asa') {
            args.push(parseInt(params.currency || '0'))
            args.push(params.currency_decimals || 1_000_000)
        }
        if (params.currency_type === 'arc200') {
            if (params.currency === null) throw new Error(`Arc200 ID cannot be null`)
            args.push(parseInt(params.currency))
            args.push(algosdk.getApplicationAddress(parseInt(params.currency)))
        }
    } catch (e) {
        throw new Error(`Error while formatting currency args: ${e}`)
    }
    return args

}

function formatNftID(params: ListingParams): (number | string)[] {
    const args: (number | string)[] = []
    if (!params.asset_id) throw new Error(`asset_id is null`)
    try {
        if (params.asset_type === 'arc72') {
            const [nftAppId, _] = params.asset_id.split('/')
            args.push(parseInt(nftAppId))
        } else if (params.asset_type !== 'offchain') args.push(params.asset_id)
    } catch (e) {
        throw new Error(`Invalid asset id ${params.asset_id}. ${e}`)
    }
    return args
}